# ESP8266 WiFi controlled watering can

## Overview

First attempt at automating watering of plants. 

Measures soil humidity, as well as air temperature and relative humidity.
Based on soilhumidity reading, it controls a motor (via N-channel MOSFET)
to water the plant for a specified period of time. Device can then sleep
for a specified period of time (up to approx. 70 mins for ESP8266).

Config and state is sync'ed with GCP IOT Registry, and readings are sent
via MQTT to GCP Pub/Sub (and subsequently stored on Firebase database for
analysis).

