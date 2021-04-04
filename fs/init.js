load('api_config.js');
load('api_rpc.js');
load('api_adc.js');
load('api_mqtt.js');
load('api_sys.js');
load('api_timer.js');
load('api_gpio.js');
load('api_esp32.js');
load('api_math.js');
load('api_dht.js');

let led_pin = 4;
GPIO.setup_output(led_pin, 0);

let adc_sensor_pin = 33;
let adc_enable = ADC.enable(adc_sensor_pin);
print('INIT: Enabled ADC pin ', adc_sensor_pin, ' with success: ', adc_enable);

let motor_gpio_pin = 27;
GPIO.setup_output(motor_gpio_pin, 0);

let dht_gpio_pin = 18;
let dht = DHT.create(dht_gpio_pin, DHT.DHT11);

let MIN_IN_USEC = 1 * 60 * 1000000; // 1 min in usecs
let SEC_IN_USEC = 1000000;

let peripherals_switch_pin = 21;
GPIO.setup_output(peripherals_switch_pin, 0);

let state = {
  mustSleep: 0,
  ledState: 0,
  minutesToSleep: 240,
  humidityThreshold: 50,
  wateringDurationMsec: 2500,
  busy: 0,
};

let response = {
  success: 1,
};

function readADCSensor() {
  let adc_reading = ADC.read(adc_sensor_pin);
  let adc_percentage = adc_reading * 100.0 / 4095.0;
  return {
    adc_reading: adc_reading,
    adc_percentage: adc_percentage * 1.0,
  };
}

function sleep() {
  print('Entering deep sleep...');
  let usec_to_sleep = state.minutesToSleep * MIN_IN_USEC;
  ESP32.deepSleep(usec_to_sleep); // sleep for specified usecs (up to max)
  // when ESP restarts, it will re-initialise itself
}

function waterPlant() {
  GPIO.write(motor_gpio_pin, 1);

  // wait for the required duration and stop motor
  Timer.set(state.wateringDurationMsec, false, function () {
    GPIO.write(motor_gpio_pin, 0);
  }, null);
}

RPC.addHandler('ADC.Read', function (args) {
  let r = readADCSensor();

  return {
    adc_reading: r.adc_reading,
    adc_percentage: r.adc_percentage * 1.0,
    success: 1
  };
});

RPC.addHandler('ToggleLED.Action', function (args) {
  state.ledState = !state.ledState;
  GPIO.write(led_pin, state.ledState);
  return {
    success: 1
  };
});

RPC.addHandler('Board.Sleep', function (args) {
  sleep();
});

RPC.addHandler('WaterPlant.Action', function (args) {
  waterPlant();
  return {
    success: 1
  };
});

RPC.addHandler('TempHumidity.Read', function (args) {
  let t = dht.getTemp();
  let h = dht.getHumidity();

  if (isNaN(h) || isNaN(t)) {
    return {
      success: 0,
      error: 'DHT_SENSOR_FAIL: Failed to get temp and humidity readings'
    };
  }

  // else return the temp and humidity in an object
  return {
    temp: t,
    humidity: h,
    success: 1
  };
});

let stateTopic = '/devices/' + Cfg.get('device.id') + '/state';
let iotTopic = '/devices/' + Cfg.get('device.id') + '/events';
let gcp_config_topic = '/devices/' + Cfg.get('device.id') + '/config';

function sendState() {
  // send status update to GCP
  let msg = JSON.stringify({
    free: Sys.free_ram(),
    total: Sys.total_ram(),
    adc_enable: adc_enable
  });
  print(stateTopic, '->', msg);
  let ok = MQTT.pub(stateTopic, msg, 1);
  print('GCP STATUS message published ok: ', ok);
}

function checkWateringResult() {
  print('Checking result of watering...');
  let adc_r = readADCSensor();
  let soil_humidity = Math.round((100 - adc_r.adc_percentage) * 10.0) / 10.0; // get new reading

  print('New soil humidity: ', soil_humidity, ' vs old soil humidity: ', response.soil_humidity);
  // if there's no material movement in the reading, something is wrong
  if (soil_humidity < response.soil_humidity + 1.0) {
    print('Something went wrong with the watering; increasing duration');

    // try increasing the watering duration
    state.wateringDurationMsec = state.wateringDurationMsec * 1.5;

    // set an error message
    response.success = 0;
    response.error = 'PUMP_OR_HUMIDITY_SENSOR_FAIL: Watering pump or soil humidity sensor failure';
  }

  if ((soil_humidity < state.humidityThreshold) && response.attempt < 5) {
    response.attempt++;
    response.watered_flag = 1; // set the 'watered_flag' field to true (1) 
    
    print('Watering plant');
    waterPlant();
    
    // wait for a few seconds and check soil humidity to ensure that watering has taken place
    Timer.set(state.wateringDurationMsec + 30 * 1000, false, checkWateringResult, null);
  } else {
    response.soil_humidity = soil_humidity;
    let r = JSON.stringify(response); 

    // Send sensor readings and watered_flag to GCP IOT Cloud
    print('Sensor readings to submit to GCP Cloud: ', r);
    let ok = MQTT.pub(iotTopic, r, 1);
    print('Message published ok: ', ok);

    Timer.set(10 * 1000, false, function () { state.busy = 0 }, null);
  }
}

function sendMeterReadingsAndWater() {
  state.busy = 1;

  let adc_r = readADCSensor();
  adc_r = readADCSensor();
  adc_r = readADCSensor();

  // reverse the reading; soil humidity reading is 0 when sensor immersed in water
  let soil_humidity = Math.round((100 - adc_r.adc_percentage) * 10.0) / 10.0;

  response = {
    success: 1,
    soil_humidity: soil_humidity * 1.0,
  };

  let t = dht.getTemp();
  let h = dht.getHumidity();

  if (!isNaN(h)) {
    response.humidity = h;
  }

  if (!isNaN(t)) {
    response.temp = t;
  }

  // if soil humidity is super high (e.g. higher than 90%), something is wrong, report
  if (soil_humidity >= 90.0) {
    response.success = 0;
    response.error = 'SOIL_HUMIDITY_SENSOR_FAIL: Soil humidity sensor failure; cannot be higher than 90%';
    print('Soil humidity sensor failure; cannot be higher than 90%');
  }

  if (soil_humidity < state.humidityThreshold) {
    response.attempt = 1;
    response.watered_flag = 1; // set the 'watered_flag' field to true (1) 
    
    print('Watering plant');
    waterPlant();
    
    // wait for a few seconds and check soil humidity to ensure that watering has taken place
    Timer.set(state.wateringDurationMsec + 30 * 1000, false, checkWateringResult, null);
  } else {
    let r = JSON.stringify(response);

    // Send sensor readings and watered_flag to GCP IOT Cloud
    print('Sensor readings to submit to GCP Cloud: ', r);
    let ok = MQTT.pub(iotTopic, r, 1);
    print('Message published ok: ', ok);

    Timer.set(10 * 1000, false, function () { state.busy = 0 }, null);
  }
}

// subscribe to config changes (update state)
MQTT.sub(gcp_config_topic, function (conn, t, msg) {
  print('Topic:', t, 'message:', msg);
  let obj = JSON.parse(msg) || {
    led_state: 1,
    must_sleep: 0,
    humidity_threshold: 50,
    minutes_to_sleep: 240,
    watering_duration_msec: 2500
  };

  state.ledState = obj.led_state;
  state.mustSleep = obj.must_sleep;
  state.humidityThreshold = obj.humidity_threshold;
  state.minutesToSleep = obj.minutes_to_sleep;
  state.wateringDurationMsec = obj.watering_duration_msec;

  GPIO.write(led_pin, state.ledState);
}, null);

// if connection has been established with GCP, send data, water if needed, then sleep
MQTT.setEventHandler(function (conn, ev, edata) {
  if (ev === MQTT.EV_CONNACK) {
    print("MQTT connection established.");

    sendState();

    // wait for 10 sec to ensure accurate sensor readings and update config state
    Timer.set(1000 * 10, false, function () {

      sendMeterReadingsAndWater();

      if (state.mustSleep) { // check if we are required to sleep to save energy
        // Wait a few seconds to ensure state and data has been sent
        // Timer repeats as it will be checking to ensure 'busy' state is set to 0 before deep sleep
        Timer.set(1000 * 10, Timer.REPEAT, function () { if (!state.busy) { sleep(); } }, null);
      }

    }, null);
  }
}, null);

// set a timer to repeat the watering sequence. This is useful in case we have paused "sleeping" (config change)
Timer.set(1000 * 60 * state.minutesToSleep /* repeat */ , Timer.REPEAT, function () {
  sendState();

  // wait for 10 sec to ensure accurate sensor readings and update config state
  Timer.set(1000 * 10, false, function () {

    sendMeterReadingsAndWater();

    if (state.mustSleep) { // check if we are required to sleep to save energy
      // Wait a few seconds to ensure state and data has been sent
      // Timer repeats as it will be checking to ensure 'busy' state is set to 0 before deep sleep
      Timer.set(1000 * 10, Timer.REPEAT, function () { if (!state.busy) { sleep(); } }, null);
    }

  }, null);
}, null);