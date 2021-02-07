load('api_config.js');
load('api_rpc.js');
load('api_adc.js');
load('api_mqtt.js');
load('api_sys.js');
load('api_timer.js');
load('api_gpio.js');
load('api_esp8266.js');
load('api_math.js');
load('api_dht.js');

let led_pin = 15;
GPIO.setup_output(led_pin, 0);

let adc_sensor_pin = 0;
let adc_enable = ADC.enable(0);
print('INIT: Enabled ADC pin ', adc_sensor_pin, ' with success: ', adc_enable);

let motor_gpio_pin = 13;
GPIO.setup_output(motor_gpio_pin, 0);

let dht_gpio_pin = 4;
let dht = DHT.create(dht_gpio_pin, DHT.DHT11);

let MAX_USEC_TO_SLEEP = 4294967295;
let MIN_IN_USEC = 1 * 60 * 1000000;

let state = {
  mustSleep: 0,
  ledState: 0, 
  minutesToSleep: 70,
  humidityThreshold: 45,
  wateringDurationMsec: 2500
};

function readADCSensor() {
  let adc_reading = ADC.read(adc_sensor_pin);
  let adc_percentage = adc_reading * 100 / 1024;
  return {
    adc_reading: adc_reading,
    adc_percentage: adc_percentage
  };
}

function sleep() {
  print('Entering deep sleep...');
  let usec_to_sleep = Math.max(MAX_USEC_TO_SLEEP, state.minutesToSleep * MIN_IN_USEC);
  ESP8266.deepSleep(usec_to_sleep); // sleep for specified usecs (up to max)
  // when restarts, it will re-initialise itself
}

function waterPlant() {
    GPIO.write(motor_gpio_pin, 1);
    Sys.usleep(state.wateringDurationMsec*1000);
    GPIO.write(motor_gpio_pin, 0);
}

RPC.addHandler('ADC.Read', function(args) {
  let r = readADCSensor();

  return {
    adc_reading: r.adc_reading,
    adc_percentage: r.adc_percentage,
    success: 1
  };
});

RPC.addHandler('ToggleLED.Action', function(args) {
  state.ledState = !state.ledState;
  GPIO.write(led_pin, state.ledState);
  return { success: 1 };
});

RPC.addHandler('Board.Sleep', function(args) {
  sleep();
});

RPC.addHandler('WaterPlant.Action', function(args) {
  waterPlant();
  return { success: 1 };
});

RPC.addHandler('TempHumidity.Read', function(args) {
  let t = dht.getTemp();
  let h = dht.getHumidity();

  if (isNaN(h) || isNaN(t)) {
    return {
      success: 0,
      error: 'ERROR: Failed to get temp and humidity readings'
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
  let msg = JSON.stringify({free: Sys.free_ram(), total: Sys.total_ram(), adc_enable: adc_enable});
  print(stateTopic, '->', msg);
  let ok = MQTT.pub(stateTopic, msg, 1);
  print('GCP STATUS message published ok: ', ok);
}

function sendMeterReadingsAndWater() {
  let adc_r = readADCSensor();
  let soil_humidity = 100 - adc_r.adc_percentage; // soil humidity reading is 0 when sensor immersed in water

  let response = { 
    success: 1, 
    soil_humidity: Math.floor(soil_humidity),
  };

  let t = dht.getTemp();
  let h = dht.getHumidity();
  
  if (!isNaN(h)) {
    response.humidity = h;
  }
  
  if (!isNaN(t)) {
    response.temp = t;
  }  

  // If soil_humidity is less than WATERED_THRESHOLD%, then water the plant automatically for 1.5 sec
  if (response.soil_humidity < state.humidityThreshold) {
    waterPlant();

    // set the 'watered_flag' field to true (1) in the response to know that we have watered the plant
    response.watered_flag = 1;
  }

  let r = JSON.stringify(response);

  // Send sensor readings and watered_flag to GCP IOT Cloud
  print('Sensor readings to submit to GCP Cloud: ', r);
  let ok = MQTT.pub(iotTopic, r, 1);
  print('Message published ok: ', ok);
}

// subscribe to config changes (update state)
MQTT.sub(gcp_config_topic, function(conn, t, msg) {
  print('Topic:', t, 'message:', msg);
  let obj = JSON.parse(msg) || { led_state: 1, must_sleep: 0, humidity_threshold: 45, minutes_to_sleep: 70, watering_duration_msec: 2000};

  state.ledState = obj.led_state;
  state.mustSleep = obj.must_sleep;
  state.humidityThreshold = obj.humidity_threshold;
  state.minutesToSleep = obj.minutes_to_sleep;
  state.wateringDurationMsec = obj.watering_duration_msec;

  GPIO.write(led_pin, state.ledState);
}, null);

// if connection has been established with GCP, send data, water if needed, then sleep for ~15 mins
MQTT.setEventHandler(function(conn, ev, edata) {
	if (ev === MQTT.EV_CONNACK) {
    print("MQTT connection established.");

    sendState();

    // wait for 5 sec to ensure accurate sensor readings and update config state
    Timer.set(1000 * 5, false, function() {
      
      sendMeterReadingsAndWater();

      if (state.mustSleep) { // check if we are required to sleep to save energy
        // Wait a moment to ensure the message has really been sent 
        Timer.set(1000 * 2, false, sleep, null);
      }

    }, null);
	}
}, null);

// set a timer to repeat the watering sequence. This is useful in case we have paused "sleeping" (config change)
Timer.set(1000 * 60 * state.minutesToSleep /* repeat */, Timer.REPEAT, function() {
  sendState();

  // wait for 5 sec to ensure accurate sensor readings and update config state
  Timer.set(1000 * 5, false, function() {
    
    sendMeterReadingsAndWater();

    if (state.mustSleep) { // check if we are required to sleep to save energy
      // Wait a moment to ensure the message has really been sent 
      Timer.set(1000 * 2, false, sleep, null);
    }

  }, null);
}, null);
