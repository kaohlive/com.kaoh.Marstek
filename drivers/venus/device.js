'use strict';

const Homey = require('homey');
const ModbusClient = require('../../api/ModbusClient');

class VenusBatteryDevice extends Homey.Device {

  async onInit() {
    this.log('VenusBatteryDevice has been initialized');

    await this.setCapabilityNames();

    // Get device settings
    this.settings = this.getSettings();
    
    // Initialize Modbus client
    this.modbus = new ModbusClient();
    
    // Previous values for event detection
    this.previousValues = {};
    
    // Setup Modbus event handlers
    this.setupModbusHandlers();
    
    // Start polling
    this.startPolling();
    
    // Register capability listeners for writable registers
    this.registerCapabilityListener('target_power', this.onCapabilityTargetPower.bind(this));
    this.registerCapabilityListener('charge_mode', this.onCapabilityChargeMode.bind(this));
    this.registerCapabilityListener('user_work_mode', this.onCapabilityUserWorkMode.bind(this));

    //Setup some global vars that we get from the device on init
    this.batteryCapacity=0;
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('Settings changed:', changedKeys);
    
    if (changedKeys.includes('ip') || changedKeys.includes('port') || changedKeys.includes('poll_interval')) {
      this.settings = newSettings;
      this.restartPolling();
    }
  }

  setupModbusHandlers() {
    this.modbus.on('connect', () => {
      this.setAvailable();
      this.log('Connected to Modbus device');
      this.processDeviceStaticInfo(this.settings.slave_id || 1);
    });

    this.modbus.on('error', (error) => {
      this.setUnavailable(`Connection failed: ${error.message}`);
      this.log('Modbus connection error:', error);
    });

    this.modbus.on('close', () => {
      this.log('Modbus connection closed');
    });
  }

  async connectModbus() {
    if (this.modbus.isConnected()) {
      return true;
    }

    try {
      const success = await this.modbus.connect({
        ip: this.settings.ip,
        port: this.settings.port || 502
      });
      
      return success;
    } catch (error) {
      this.log('Modbus connection failed:', error);
      return false;
    }
  }

  disconnectModbus() {
    if (this.modbus) {
      this.modbus.disconnect();
      this.log('Disconnected from Modbus device');
    }
  }

  startPolling() {
    this.stopPolling();
    
    const interval = this.settings.poll_interval || 5000;
    this.pollInterval = setInterval(async () => {
      await this.pollData();
    }, interval);
    
    // Initial poll
    setTimeout(() => this.pollData(), 1000);
  }

  stopPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  restartPolling() {
    this.stopPolling();
    this.disconnectModbus();
    this.startPolling();
  }

  //Update info that does not change often, we do this on device init, if you whant new data, just restart the app
  async processDeviceStaticInfo(slaveId)
  {
    try{
      // Battery total energy, this is the capacity of the device, not chaning (0.001kwh resolution)
      const reg_energy = await this.modbus.readHoldingRegisters(slaveId, 32105, 1);
      this.batteryCapacity = ModbusClient.bufferToUint16(Buffer.concat(reg_energy)) * 0.001; // Now in kwh
    } catch (error) {
      this.log('Device static info error:', error);
      this.setUnavailable(`Retrieval of static info failed: ${error.message}`);
    }
  }

  async pollData() {
    if (!await this.connectModbus()) {
      return;
    }

    try {
      const slaveId = this.settings.slave_id || 1;
      console.log('Attempt to read registers for slave device ['+slaveId+']')
      // Read battery status registers (example addresses based on typical battery systems)
      console.log('Get battery data [slave '+slaveId+']')
      await this.processBatteryState(slaveId);

      console.log('Get battery health [slave '+slaveId+']')
      await this.processBatteryState(slaveId);

      // Read system health data
      console.log('Get system health [slave '+slaveId+']')
      this.processBatteryHealth(slaveId);

      // Read system operation status registers
      console.log('Get system data [slave '+slaveId+']')
      this.processSystemData(slaveId);

    } catch (error) {
      this.log('Polling error:', error);
      this.setUnavailable(`Polling failed: ${error.message}`);
    }
  }

  async processBatteryState(slaveId) {
    try {
      // AC Output voltage (0.1V resolution)
      const reg_voltage_ac =await this.modbus.readHoldingRegisters(slaveId, 32200, 1);
      const voltage_ac = ModbusClient.bufferToUint16(Buffer.concat(reg_voltage_ac)) * 0.1;
      this.setCapabilityValue('measure_voltage', voltage_ac).catch(this.error);
      // AC Output current (0.1A resolution, signed)
      const reg_current_ac = await this.modbus.readHoldingRegisters(slaveId, 32201, 1);
      const current_ac = ModbusClient.bufferToInt16(Buffer.concat(reg_current_ac)) * 0.01;
      this.setCapabilityValue('measure_current', current_ac).catch(this.error);
      //AC power output, this is the main interaction between our house and the ESS
      const reg_power_ac = await this.modbus.readHoldingRegisters(slaveId, 32202, 2);
      const power_ac = ModbusClient.bufferToInt32(Buffer.concat(reg_power_ac));
      this.setCapabilityValue('measure_power', power_ac).catch(this.error);
      //But we also set the discharge and charge versions for easy of use
      if (power_ac < 0) {
        this.setCapabilityValue('measure_power.imported', power_ac).catch(this.error);
        this.setCapabilityValue('measure_power.exported', 0).catch(this.error);
      } else {
        this.setCapabilityValue('measure_power.imported', 0).catch(this.error);
        this.setCapabilityValue('measure_power.exported', Math.abs(power_ac)).catch(this.error);
      }
      // State of Charge (1% resolution)
      const reg_soc = await this.modbus.readHoldingRegisters(slaveId, 32104, 1);
      const soc=ModbusClient.bufferToUint16(Buffer.concat(reg_soc));
      this.setCapabilityValue('measure_battery', soc).catch(this.error);
      const stored_energy = this.batteryCapacity * (soc/100);
      this.setCapabilityValue('meter_power.capacity', stored_energy).catch(this.error);
      
      // Trigger SOC events
      this.triggerSOCEvents(soc);

      // Battery power, these are internal pre inverter values (1W resolution, signed)
      const reg_power = await this.modbus.readHoldingRegisters(slaveId, 32102, 2);
      const power = ModbusClient.bufferToInt32(Buffer.concat(reg_power)); //Homey want w
      
      //First we set the main measure capability
      this.setCapabilityValue('measure_power.battery', power).catch(this.error);
      // Battery voltage (0.1V resolution)
      const reg_voltage =await this.modbus.readHoldingRegisters(slaveId, 32100, 1);
      const voltage = ModbusClient.bufferToUint16(Buffer.concat(reg_voltage)) * 0.01;
      this.setCapabilityValue('measure_voltage.battery', voltage).catch(this.error);

      // Battery current (0.1A resolution, signed)
      const reg_current = await this.modbus.readHoldingRegisters(slaveId, 32101, 1);
      const current = ModbusClient.bufferToInt16(Buffer.concat(reg_current)) * 0.01;
      this.setCapabilityValue('measure_current.battery', current).catch(this.error);

    } catch (error) {
      this.log('Error processing battery state:', error);
    }
  }

  async processBatteryHealth(slaveId) {
    try {
      // Internal Temperature
      const reg_temp_int =await this.modbus.readHoldingRegisters(slaveId, 35000, 1);
      const temp_int = ModbusClient.bufferToInt16(Buffer.concat(reg_temp_int)) * 0.1;
      this.setCapabilityValue('measure_temperature', temp_int).catch(this.error);

      // Internal mos1
      const reg_temp_mos1 =await this.modbus.readHoldingRegisters(slaveId, 35001, 1);
      const temp_mos1 = ModbusClient.bufferToInt16(Buffer.concat(reg_temp_mos1)) * 0.1;
      this.setCapabilityValue('measure_temperature.mos1', temp_mos1).catch(this.error);
      // Internal mos1
      const reg_temp_mos2 =await this.modbus.readHoldingRegisters(slaveId, 35002, 1);
      const temp_mos2 = ModbusClient.bufferToInt16(Buffer.concat(reg_temp_mos2)) * 0.1;
      this.setCapabilityValue('measure_temperature.mos2', temp_mos2).catch(this.error);
    } catch (error) {
      this.log('Error processing battery state:', error);
    }
  }

  async processSystemData(slaveId) {

    try {

      // Battery total chargin energy (0.001kwh resolution)
      const reg_total_charge_energy = await this.modbus.readHoldingRegisters(slaveId, 33000, 2);
      const total_charge_energy = ModbusClient.bufferToUint32(Buffer.concat(reg_total_charge_energy)) * 0.001; // Now in kwh
      this.setCapabilityValue('meter_power.imported', total_charge_energy).catch(this.error);

      // Battery total discharge energy (0.001kwh resolution)
      const reg_total_discharge_energy = await this.modbus.readHoldingRegisters(slaveId, 33002, 2);
      const total_discharge_energy = ModbusClient.bufferToInt32(Buffer.concat(reg_total_discharge_energy)) * 0.001; // Now in kwh
      this.setCapabilityValue('meter_power.exported', total_discharge_energy).catch(this.error);

      // Inverter state
      const reg_inverter_state = await this.modbus.readHoldingRegisters(slaveId, 35100, 1);
      const inverter_state = ModbusClient.bufferToUint16(Buffer.concat(reg_inverter_state));
      const modeStr = this.driver.INVERTER_MODES[inverter_state];
      // Trigger operation mode change event
      const previousMode = this.getCapabilityValue('operation_mode');
      if (previousMode && previousMode !== modeStr) {
        this.homey.flow.getDeviceTriggerCard('operation_mode_changed')
          .trigger(this, { mode: modeStr }, { mode: modeStr })
          .catch(this.error);
      }
      this.setCapabilityValue('operation_mode', modeStr).catch(this.error);
      //Force mode
      const reg_force_mode = await this.modbus.readHoldingRegisters(slaveId, 42010, 1);
      const force_mode = ModbusClient.bufferToUint16(Buffer.concat(reg_force_mode));
      const forceModeStr = this.driver.FORCE_MODES[force_mode];
      this.setCapabilityValue('charge_mode', forceModeStr).catch(this.error);
      //Work mode
      const reg_work_mode = await this.modbus.readHoldingRegisters(slaveId, 43000, 1);
      const work_mode = ModbusClient.bufferToUint16(Buffer.concat(reg_work_mode));
      const workModeStr = this.driver.WORK_MODES[work_mode];
      this.setCapabilityValue('user_work_mode', workModeStr).catch(this.error);

      //Process my states for events
      this.processStatusFlags(modeStr, 0);

    } catch (error) {
      this.log('Error processing system data:', error);
    }
  }

  processStatusFlags(mode, flags) {
    const STATUS_MAP = {
      charge: 'charging',
      discharge: 'discharging'
    };

    const charging = !!(flags & 0x01);
    const discharging = !!(flags & 0x02);
    const fault = !!(flags & 0x04);
    const warning = !!(flags & 0x08);

    const currentStatus = STATUS_MAP[mode] ?? 'idle';
    const previousStatus = this.getCapabilityValue('battery_charging_state');

    this.setCapabilityValue('battery_charging_state', currentStatus).catch(this.error);
    this.setCapabilityValue('alarm_generic', fault || warning).catch(this.error);
    
    // Trigger charging status change events
    if (previousStatus && previousStatus !== currentStatus) {
      this.homey.flow.getDeviceTriggerCard('charging_status_changed')
        .trigger(this, { status: currentStatus }, { status: currentStatus })
        .catch(this.error);
        
      if (currentStatus === 'charging') {
        this.homey.flow.getDeviceTriggerCard('battery_started_charging')
          .trigger(this, {}, {})
          .catch(this.error);
      } else if (currentStatus === 'discharging') {
        this.homey.flow.getDeviceTriggerCard('battery_started_discharging')
          .trigger(this, {}, {})
          .catch(this.error);
      }
    }
    
    // Trigger alarm events
    if (fault && !this.previousValues.fault) {
      this.homey.flow.getDeviceTriggerCard('battery_fault_detected')
        .trigger(this, {}, {})
        .catch(this.error);
    }
    
    if (warning && !this.previousValues.warning) {
      this.homey.flow.getDeviceTriggerCard('battery_warning_detected')
        .trigger(this, {}, {})
        .catch(this.error);
    }
    
    this.previousValues.chargingStatus = currentStatus;
    this.previousValues.fault = fault;
    this.previousValues.warning = warning;
  }


  triggerSOCEvents(soc) {
    const previousSOC = this.previousValues.soc;
    
    if (previousSOC !== undefined) {
      // Trigger SOC threshold events
      const thresholds = [10, 20, 50, 80, 90];
      
      thresholds.forEach(threshold => {
        if (previousSOC > threshold && soc <= threshold) {
          this.homey.flow.getDeviceTriggerCard('soc_below_threshold')
            .trigger(this, { threshold }, { threshold })
            .catch(this.error);
        } else if (previousSOC < threshold && soc >= threshold) {
          this.homey.flow.getDeviceTriggerCard('soc_above_threshold')
            .trigger(this, { threshold }, { threshold })
            .catch(this.error);
        }
      });
    }
    
    this.previousValues.soc = soc;
  }

  triggerTemperatureEvents(temperature) {
    const previousTemp = this.previousValues.temperature;
    
    if (previousTemp !== undefined) {
      // Temperature alarm thresholds
      const highTemp = 50; // 50°C
      const lowTemp = -10; // -10°C
      
      if (previousTemp < highTemp && temperature >= highTemp) {
        this.homey.flow.getDeviceTriggerCard('temperature_too_high')
          .trigger(this, { temperature }, {})
          .catch(this.error);
      }
      
      if (previousTemp > lowTemp && temperature <= lowTemp) {
        this.homey.flow.getDeviceTriggerCard('temperature_too_low')
          .trigger(this, { temperature }, {})
          .catch(this.error);
      }
    }
    
    this.previousValues.temperature = temperature;
  }

  // Write operations for supported registers
  async onCapabilityTargetPower(value) {
    try {
      if (!await this.connectModbus()) {
        throw new Error('Modbus connection failed');
      }
      
      const slaveId = this.settings.slave_id || 1;
      await this.modbus.writeSingleRegister(slaveId, 40100, Math.round(value));
      this.log('Target power set to:', value);
      
    } catch (error) {
      this.log('Error setting target power:', error);
      throw new Error('Failed to set target power');
    }
  }

  async onCapabilityChargeMode(value) {
    try {
      if (!await this.connectModbus()) {
        throw new Error('Modbus connection failed');
      }
      const currentChargeMode = this.getCapabilityValue('user_work_mode');
      if(currentChargeMode!=='manual')
        return Promise.reject(new Error('Failed to set charge mode'));
      
      const slaveId = this.settings.slave_id || 1;
      const modeValue = Object.keys(this.driver.FORCE_MODES).find(
        key => this.driver.FORCE_MODES[key] === value
      );
      console.log('Attempt tp set mode to '+modeValue+' based on '+value);
      await this.modbus.writeSingleRegister(slaveId, 42010, modeValue);
      this.log('Charge mode set to:', value);
      
    } catch (error) {
      this.log('Error setting charge mode:', error);
      throw new Error('Failed to set charge mode');
    }
  }

    async onCapabilityUserWorkMode(value) {
    try {
      if (!await this.connectModbus()) {
        throw new Error('Modbus connection failed');
      }
      
      const slaveId = this.settings.slave_id || 1;
      const userWorkValue = Object.keys(this.driver.WORK_MODES).find(
        key => this.driver.WORK_MODES[key] === value
      );
      console.log('Attempt to set Work mode to '+userWorkValue+' based on '+value);
      await this.modbus.writeSingleRegister(slaveId, 43000, userWorkValue);
      this.log('Work mode set to:', value);
      
    } catch (error) {
      this.log('Error setting work mode:', error);
      throw new Error('Failed to set work mode');
    }
  }

  chargeModeToValue(mode) {
    const modes = {
      'auto': 0,
      'force_charge': 1,
      'force_discharge': 2,
      'standby': 3
    };
    return modes[mode] || 0;
  }

  // Flow card condition handlers
  async conditionIsCharging() {
    const status = this.getCapabilityValue('charging_status');
    return status === 'charging';
  }

  async conditionIsDischarging() {
    const status = this.getCapabilityValue('charging_status');
    return status === 'discharging';
  }

  async conditionSOCAbove(args) {
    const soc = this.getCapabilityValue('measure_battery');
    return soc > args.percentage;
  }

  async conditionSOCBelow(args) {
    const soc = this.getCapabilityValue('measure_battery');
    return soc < args.percentage;
  }

  async conditionOperationModeIs(args) {
    const mode = this.getCapabilityValue('operation_mode');
    return mode === args.mode;
  }

  async conditionHasFault() {
    const alarm = this.getCapabilityValue('alarm_generic');
    return alarm === true;
  }

  async conditionTemperatureAbove(args) {
    const temperature = this.getCapabilityValue('measure_temperature');
    return temperature > args.temperature;
  }

  // Flow card action handlers
  async actionSetChargeMode(args) {
    try {
      await this.onCapabilityChargeMode(args.mode);
      return true;
    } catch (error) {
      this.log('Flow action set charge mode failed:', error);
      throw error;
    }
  }

  async actionSetTargetPower(args) {
    try {
      await this.onCapabilityTargetPower(args.power);
      return true;
    } catch (error) {
      this.log('Flow action set target power failed:', error);
      throw error;
    }
  }

  async onDeleted() {
    this.log('VenusBatteryDevice deleted');
    this.stopPolling();
    this.disconnectModbus();
  }

  async setCapabilityNames(){
    await this.setCapabilityOptions('measure_voltage', {
        title: {
          en: 'Grid output Voltage',
          nl: 'Netuitvoer voltage'
        }
      });
    await this.setCapabilityOptions('measure_voltage.battery', {
        title: {
          en: 'Battery Voltage',
          nl: 'Batterij voltage'
        }
      });
    await this.setCapabilityOptions('measure_current', {
        title: {
          en: 'Grid output Current',
          nl: 'Netuitvoer stroom'
        }
      });
    await this.setCapabilityOptions('measure_current.battery', {
        title: {
          en: 'Battery Current',
          nl: 'Batterij stroom'
        }
      });
    await this.setCapabilityOptions('measure_power', {
        title: {
          en: 'Grid output Power',
          nl: 'Netuitvoer vermogen'
        }
      });
    await this.setCapabilityOptions('measure_power.battery', {
        title: {
          en: 'Battery Power',
          nl: 'Batterij vermogen'
        }
      });
    await this.setCapabilityOptions('measure_power.imported', {
        title: {
          en: 'Charging Power',
          nl: 'Laden vermogen'
        }
      });
    await this.setCapabilityOptions('measure_power.exported', {
        title: {
          en: 'Discharging Power',
          nl: 'Ontladen vermogen'
        }
      });
    await this.setCapabilityOptions('meter_power.imported', {
        title: {
          en: 'Charged Energy',
          nl: 'Opgeslagen energie'
        }
      });    
    await this.setCapabilityOptions('meter_power.exported', {
        title: {
          en: 'Discharged Energy',
          nl: 'Geleverd energie'
        }
      });
    await this.setCapabilityOptions('meter_power.capacity', {
        title: {
          en: 'Energy available',
          nl: 'Energie beschikbaar'
        }
      });
    await this.setCapabilityOptions('measure_temperature', {
        title: {
          en: 'Internal temperature',
          nl: 'Interne temperatuur'
        }
      });
    await this.setCapabilityOptions('measure_temperature.mos1', {
        title: {
          en: 'MOSFET 1 temperature',
          nl: 'MOSFET 1 temperatuur'
        }
      });
    await this.setCapabilityOptions('measure_temperature.mos2', {
        title: {
          en: 'MOSFET 2 temperature',
          nl: 'MOSFET 2 temperatuur'
        }
      });
  }
}

module.exports = VenusBatteryDevice;