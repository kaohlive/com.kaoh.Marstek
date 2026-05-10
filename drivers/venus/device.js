'use strict';

const Homey = require('homey');
const ModbusClient = require('../../api/ModbusClient');

class VenusBatteryDevice extends Homey.Device {

  async onInit() {
    this.log('VenusBattery Device has been initialized');

    // Track if device is being deleted to prevent operations on deleted device
    this._isDeleted = false;

    // Get device settings
    this.settings = this.getSettings();

    // Initialize Modbus client
    this.modbus = new ModbusClient();

    // Apply connection timeout setting to ModbusClient
    if (this.settings.connection_timeout) {
      this.modbus.connectionTimeout = this.settings.connection_timeout;
    }

    // Previous values for event detection
    this.previousValues = {};

    // Error tracking for graceful degradation
    this.consecutiveErrors = 0;
    this.maxConsecutiveErrors = this.settings.max_consecutive_errors || 3;

    // Mode-events ringbuffer for write/read latency diagnostics. Passive: only
    // records timestamps and raw register values to support data-driven tuning
    // of work-mode write→stable-read behaviour. Bounded to prevent unbounded
    // memory growth; oldest entries are dropped as new ones arrive.
    this._modeEvents = [];
    this._modeEventsMax = 500;
    this._modeEventSeq = 0;
    this._pendingWorkModeWrites = []; // tracks unmatched writes to compute ack-latency on poll

    // Setup Modbus event handlers
    this.setupModbusHandlers();

    // Fix missing capabilities
    await this.repairCapabilities();

    // Start polling
    this.startPolling();

    // Register capability listeners for writable registers
    this.setupCapabilityListeners();
    //Register flow trigger cards
    this.registerFlowCardTriggers();
    //Setup some global vars that we get from the device on init
    this.batteryCapacity=0;
    this.deviceVersion = 'unknown'; // Will be set to 'v1v2' or 'v3' based on firmware
  }

  // ============================================
  // MODE-EVENT INSTRUMENTATION (passive, no behavior change)
  // ============================================

  _pushModeEvent(type, data) {
    const entry = {
      seq: ++this._modeEventSeq,
      ts: new Date().toISOString(),
      type,
      ...data,
    };
    this._modeEvents.push(entry);
    if (this._modeEvents.length > this._modeEventsMax) {
      this._modeEvents.splice(0, this._modeEvents.length - this._modeEventsMax);
    }
    return entry;
  }

  // Returns a shallow copy so callers (API/settings page) cannot mutate state.
  getModeEvents() {
    return this._modeEvents.slice();
  }

  clearModeEvents() {
    this._modeEvents = [];
    this._pendingWorkModeWrites = [];
    return true;
  }

  async repairCapabilities()
  {
    let neededFix = false;
    if(!this.hasCapability('operation_mode')) {
      await this.addCapability('operation_mode');
      this.log('Registered missing operation_mode capability');
      neededFix = true;
    }
    if(!this.hasCapability('max_charge_power_limit')) {
      await this.addCapability('max_charge_power_limit');
      this.log('Registered missing max_charge_power_limit capability');
      neededFix = true;
    }
    if(!this.hasCapability('max_discharge_power_limit')) {
      await this.addCapability('max_discharge_power_limit');
      this.log('Registered missing max_discharge_power_limit capability');
      neededFix = true;
    }
    if(!this.hasCapability('target_power')) {
      await this.addCapability('target_power');
      this.log('Registered missing target_power capability');
      neededFix = true;
    }
    if(!this.hasCapability('target_power_mode')) {
      await this.addCapability('target_power_mode');
      this.log('Registered missing target_power_mode capability');
      neededFix = true;
    }
    if(!this.hasCapability('onoff')) {
      await this.addCapability('onoff');
      this.log('Registered missing onoff capability');
      neededFix = true;
    }
    return neededFix;
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('Settings changed:', changedKeys);

    // Update settings
    this.settings = newSettings;

    // Apply connection timeout changes
    if (changedKeys.includes('connection_timeout')) {
      this.modbus.connectionTimeout = newSettings.connection_timeout;
      this.log(`Connection timeout updated to ${newSettings.connection_timeout}ms`);
    }

    // Apply max consecutive errors changes
    if (changedKeys.includes('max_consecutive_errors')) {
      this.maxConsecutiveErrors = newSettings.max_consecutive_errors;
      this.log(`Max consecutive errors updated to ${newSettings.max_consecutive_errors}`);
    }

    // Restart polling if connection settings changed
    if (changedKeys.includes('ip') || changedKeys.includes('port') || changedKeys.includes('poll_interval')) {
      this.restartPolling();
    }

    // Handle charging cutoff SOC change
    if (changedKeys.includes('charging_cutoff_soc')) {
      await this.setChargingCutoffSoc(newSettings.charging_cutoff_soc);
    }

    // Handle discharging cutoff SOC change
    if (changedKeys.includes('discharging_cutoff_soc')) {
      await this.setDischargingCutoffSoc(newSettings.discharging_cutoff_soc);
    }
  }

  async onRenamed(name) {
    try {
      this.log(`Device renamed to: "${name}"`);
      
      // Configuration for your specific device
      const config = {
        deviceNameRegister: 31000,  // Starting register for device name
        maxNameLength: 20,          // Maximum name length in bytes
        encoding: 'ascii',          // Character encoding
        swapBytes: false,           // Set to true if device expects swapped bytes
        littleEndian: false,        // Set to true if device uses little-endian
        padWithNull: true,          // Pad short names with null bytes
        slaveId: this.settings.slave_id || 1  // Modbus slave ID
      };
      
      // Write the new name to the device
      //await this.writeDeviceName(name, config);
      
    } catch (error) {
      this.error('Failed to write device name to Modbus device:', error);
    }
  }

async writeDeviceName(name, config) {
    const {
      deviceNameRegister,
      maxNameLength,
      encoding,
      swapBytes,
      littleEndian,
      padWithNull,
      slaveId
    } = config;
    
    // Convert string to buffer
    const buffer = this.modbus.stringToModbusBuffer(name, maxNameLength, {
      encoding,
      padWithNull,
      swapBytes
    });
    
    // Convert buffer to register values
    const registers = bufferToRegisters(buffer, littleEndian);
    
    this.log(`Writing name "${name}" as ${registers.length} registers:`, registers);
    
    // Write to Modbus device
    // Method 1: Write all registers at once (if supported)
    try {
      await this.modbus.writeMultipleRegisters(slaveId, deviceNameRegister, registers);
      this.log(`Successfully wrote device name to registers ${deviceNameRegister}-${deviceNameRegister + registers.length - 1}`);
    } catch (error) {
      // Method 2: Write registers individually if bulk write fails
      this.log('Bulk write failed, trying individual register writes...');
      
      for (let i = 0; i < registers.length; i++) {
        await this.modbus.writeSingleRegister(slaveId, deviceNameRegister + i, registers[i]);
        // Small delay between writes to avoid overwhelming the device
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      
      this.log(`Successfully wrote device name using individual register writes`);
    }
  }

  setupModbusHandlers() {
    this.modbus.on('connect', () => {
      this.setAvailable();
      this.consecutiveErrors = 0; // Reset error counter on successful connection
      this.log('Connected to Modbus device');
      this.processDeviceStaticInfo(this.settings.slave_id || 1);
    });

    this.modbus.on('error', (error) => {
      this.log('Modbus connection error:', error.message);
      // Don't immediately mark unavailable - let polling error handling decide
    });

    this.modbus.on('close', () => {
      this.log('Modbus connection closed - will attempt reconnection');
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

      const reg_device_name = await this.modbus.readHoldingRegisters(slaveId, 31000, 10);
      // Simple conversion
      const deviceName = ModbusClient.bufferToString(reg_device_name);

      // Read firmware version from register 31101 (Firmware version)
      let firmwareVersion='xxx';
      let firmwareRaw=999;
      try{
        const reg_firmware = await this.modbus.readHoldingRegisters(slaveId, 31101, 1);
        firmwareRaw = ModbusClient.bufferToUint16(Buffer.concat(reg_firmware));
        firmwareVersion = firmwareRaw.toString(); // Firmware register already contains the correct value
      } catch (error) {
        this.log('Device firmware retrieval error:', error);
      }
      // Determine device version based on device name - more reliable than firmware version
      // V3 devices typically have names like "AC01", while V1/V2 have "limited", "BI_2.5_2.5", etc.
      const deviceNameLower = deviceName.toLowerCase().trim();

      // V3 device detection patterns
      if (deviceNameLower.startsWith('ac')) {
        this.deviceVersion = 'v2';
      } else if (deviceNameLower.includes('limited') || deviceNameLower.includes('bi_')) {
        this.deviceVersion = 'v1';
      } else if (deviceNameLower.startsWith('vn')) {
        this.deviceVersion = 'v3';
      } else {
        // Fallback to firmware version detection if device name is unclear
        this.deviceVersion = firmwareRaw >= 300 ? 'v3' : 'v1v2';
        this.log(`Using firmware fallback for version detection - unknown device name: ${deviceName}`);
      }

      this.log(`Detected device version: ${this.deviceVersion} (device: "${deviceName}", firmware: ${firmwareVersion})`);

      //Now store the collected info in read only settings for easy access to the user
      this.setSettings({
        'storage_capacity': this.batteryCapacity + ' kwh',
        'device_name': deviceName,
        'firmware': firmwareVersion,
        'device_version': this.deviceVersion
      });
      //We only manage these from Homey since the Marstek app does not allow to control these
      //Force charge power
      const reg_forcecharge = await this.modbus.readHoldingRegisters(slaveId, 42020, 1);
      const force_charge = ModbusClient.bufferToUint16(Buffer.concat(reg_forcecharge));
      console.log('current charge power forced setting :'+force_charge);
      this.setCapabilityValue('force_charge_power', force_charge).catch(this.error);
      //Force discharge power
      const reg_forcedischarge = await this.modbus.readHoldingRegisters(slaveId, 42021, 1);
      const force_discharge = ModbusClient.bufferToUint16(Buffer.concat(reg_forcedischarge));
      console.log('current discharge power forced setting :'+force_discharge);
      this.setCapabilityValue('force_discharge_power', force_discharge).catch(this.error);

      // Read charging cutoff SOC (register 44000) - resolution 0.1%
      const reg_charging_cutoff = await this.modbus.readHoldingRegisters(slaveId, 44000, 1);
      const charging_cutoff_raw = ModbusClient.bufferToUint16(Buffer.concat(reg_charging_cutoff));
      const charging_cutoff_soc = charging_cutoff_raw * 0.1;
      console.log('Charging cutoff SOC: ' + charging_cutoff_soc + '%');
      this.setSettings({ 'charging_cutoff_soc': charging_cutoff_soc });

      // Read discharging cutoff SOC (register 44001) - resolution 0.1%
      const reg_discharging_cutoff = await this.modbus.readHoldingRegisters(slaveId, 44001, 1);
      const discharging_cutoff_raw = ModbusClient.bufferToUint16(Buffer.concat(reg_discharging_cutoff));
      const discharging_cutoff_soc = discharging_cutoff_raw * 0.1;
      console.log('Discharging cutoff SOC: ' + discharging_cutoff_soc + '%');
      this.setSettings({ 'discharging_cutoff_soc': discharging_cutoff_soc });
    } catch (error) {
      this.log('Device static info error:', error);
      this.setUnavailable(`Retrieval of static info failed: ${error.message}`);
    }
  }

  async pollData() {
    // Check if device has been deleted - don't poll if so
    if (this._isDeleted) {
      return;
    }

    if (!await this.connectModbus()) {
      this.consecutiveErrors++;
      this.log(`Connection failed (${this.consecutiveErrors}/${this.maxConsecutiveErrors})`);

      if (this.consecutiveErrors >= this.maxConsecutiveErrors && !this._isDeleted) {
        this.setUnavailable(`Connection failed after ${this.maxConsecutiveErrors} attempts`);
      }
      return;
    }

    try {
      const slaveId = this.settings.slave_id || 1;
      console.log('Attempt to read registers for slave device ['+slaveId+']')
      // Read battery status registers (example addresses based on typical battery systems)
      console.log('Get battery data [slave '+slaveId+']')
      await this.processBatteryState(slaveId);

      console.log('Get battery health [slave '+slaveId+']')
      await this.processBatteryHealth(slaveId);

      // Read system health data
      console.log('Get system health [slave '+slaveId+']')
      await this.processBatteryHealth(slaveId);

      // Read system operation status registers
      console.log('Get system data [slave '+slaveId+']')
      await this.processSystemData(slaveId);

      // Successful poll - reset error counter and ensure device is marked available
      this.consecutiveErrors = 0;
      if (!this._isDeleted && !this.getAvailable()) {
        this.setAvailable();
      }

    } catch (error) {
      this.consecutiveErrors++;
      this.log(`Polling error (${this.consecutiveErrors}/${this.maxConsecutiveErrors}):`, error.message);

      // Only mark unavailable after multiple consecutive failures
      if (this.consecutiveErrors >= this.maxConsecutiveErrors && !this._isDeleted) {
        this.setUnavailable(`Polling failed ${this.maxConsecutiveErrors} times: ${error.message}`);
      }
    }
  }

  async processBatteryState(slaveId) {
    try {
      // AC Output voltage (0.1V resolution)
      const reg_voltage_ac =await this.modbus.readHoldingRegisters(slaveId, 32200, 1);
      const voltage_ac = ModbusClient.bufferToUint16(Buffer.concat(reg_voltage_ac)) * 0.1;
      this.setCapabilityValue('measure_voltage', voltage_ac).catch(this.error);
      // AC Output current (0.1A resolution, signed) - V3 devices use different scaling
      const reg_current_ac = await this.modbus.readHoldingRegisters(slaveId, 32201, 1);
      const current_ac_raw = ModbusClient.bufferToInt16(Buffer.concat(reg_current_ac));
      // Different scaling for different device versions
      let current_ac;
      if (this.deviceVersion === 'v3') {
        current_ac = current_ac_raw * 0.001; // V3 devices use 0.001 scaling
      } else {
        current_ac = current_ac_raw * 0.01; // V1 and V2 devices use 0.01 scaling
      }
      this.setCapabilityValue('measure_current', current_ac).catch(this.error);
      //AC power output, this is the main interaction between our house and the ESS
      const reg_power_ac = await this.modbus.readHoldingRegisters(slaveId, 32202, 2);
      const power_ac = ModbusClient.bufferToInt32(Buffer.concat(reg_power_ac));
      //For homey we need to invert the power measure
      this.setCapabilityValue('measure_power', (power_ac*-1)).catch(this.error);
      //But we also set the discharge and charge versions for easy of use
      if (power_ac < 0) {
        this.setCapabilityValue('measure_power.imported', Math.abs(power_ac)).catch(this.error);
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

      // Battery current (0.1A resolution, signed) - V3 devices use different scaling
      const reg_current = await this.modbus.readHoldingRegisters(slaveId, 32101, 1);
      const current_raw = ModbusClient.bufferToInt16(Buffer.concat(reg_current));
      // Different scaling for different device versions
      let current;
      if (this.deviceVersion === 'v3') {
        current = current_raw * 0.001; // V3 devices use 0.001 scaling
      } else {
        current = current_raw * 0.01; // V1 and V2 devices use 0.01 scaling
      }
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

      // Process alarm and fault codes, but they dont seem to work for v3
      if (this.deviceVersion !== 'v3') {
        await this.processAlarmCodes(slaveId);
      }
    } catch (error) {
      this.log('Error processing battery state:', error);
    }
  }

  async processSystemData(slaveId) {

    try {

      // Battery total chargin energy (0.001kwh resolution)
      const reg_total_charge_energy = await this.modbus.readHoldingRegisters(slaveId, 33000, 2);
      const total_charge_energy = ModbusClient.bufferToUint32(Buffer.concat(reg_total_charge_energy)) * 0.01; // Now in kwh
      this.setCapabilityValue('meter_power.imported', total_charge_energy).catch(this.error);

      // Battery total discharge energy (0.001kwh resolution)
      const reg_total_discharge_energy = await this.modbus.readHoldingRegisters(slaveId, 33002, 2);
      const total_discharge_energy = ModbusClient.bufferToInt32(Buffer.concat(reg_total_discharge_energy)) * 0.01; // Now in kwh
      this.setCapabilityValue('meter_power.exported', total_discharge_energy).catch(this.error);

      // Inverter state
      const reg_inverter_state = await this.modbus.readHoldingRegisters(slaveId, 35100, 1);
      const inverter_state = ModbusClient.bufferToUint16(Buffer.concat(reg_inverter_state));
      this.log('Device inverstate: '+inverter_state)
      const modeStr = this.driver.INVERTER_MODES[inverter_state];
      // Trigger operation mode change event
      const previousMode = this.getCapabilityValue('operation_mode');
      this.log('Previous mode: '+previousMode+' - New mode: '+modeStr);
      // Only set capability if value changed to prevent unnecessary triggers
      if (previousMode !== modeStr) {
        this.setCapabilityValue('operation_mode', modeStr).catch(this.error);

        // Trigger operation mode change event only after value is set and if there was a previous value
        if (previousMode) {
          this.homey.flow.getDeviceTriggerCard('operation_mode_changed')
            .trigger(this, { mode: modeStr, prevMode: previousMode })
            .catch(this.error);
        }
      }
      //Force mode
      const reg_force_mode = await this.modbus.readHoldingRegisters(slaveId, 42010, 1);
      const force_mode = ModbusClient.bufferToUint16(Buffer.concat(reg_force_mode));
      const forceModeStr = this.driver.FORCE_MODES[force_mode];
      console.log('current charge mode forced :'+force_mode);

      // Only set capability if value changed to prevent unnecessary triggers
      // Preserve force_soc mode: register 42010 reads 0 (none) when force_soc is active
      // because force_soc is managed via register 42011, not 42010.
      // Preserve target_power mode: when the user drives via target_power the register
      // reads force_charge/force_discharge, but we want the unified label to stick.
      const currentForceMode = this.getCapabilityValue('force_charge_mode');
      let displayForceMode = forceModeStr;
      if (currentForceMode === 'target_power' && (forceModeStr === 'force_charge' || forceModeStr === 'force_discharge')) {
        displayForceMode = 'target_power';
      }
      if (currentForceMode === 'force_soc' && forceModeStr === 'none') {
        // Don't overwrite - force_soc is active via SOC target register
      } else if (currentForceMode !== displayForceMode) {
        this.setCapabilityValue('force_charge_mode', displayForceMode).catch(this.error);
      }
      //Work mode
      const reg_work_mode = await this.modbus.readHoldingRegisters(slaveId, 43000, 1);
      let work_mode = ModbusClient.bufferToUint16(Buffer.concat(reg_work_mode));
      const reg_force_mode_state = await this.modbus.readHoldingRegisters(slaveId, 42000, 1);
      const force_mode_state = ModbusClient.bufferToUint16(Buffer.concat(reg_force_mode_state));
      console.log('force mode enabled? ('+force_mode_state+'): '+(force_mode_state==21930));
      if(force_mode_state==21930)
        work_mode=3;
      console.log('workmode: '+work_mode);
      const workModeStr = this.driver.WORK_MODES[work_mode];

      // Diagnostic: for every poll, advance pending work-mode writes so we can
      // measure how many polls (and ms) it took for the device to expose the
      // new value via reads. Match logic mirrors the merge in lines above:
      // when 42000=21930 the effective work_mode is forced to 3 (control_mode),
      // so we check 42000 for control_mode targets and 43000 for the rest.
      if (this._pendingWorkModeWrites && this._pendingWorkModeWrites.length > 0) {
        const rawReg43000 = ModbusClient.bufferToUint16(Buffer.concat(reg_work_mode));
        const rawReg42000 = force_mode_state;
        const stillPending = [];
        for (const pending of this._pendingWorkModeWrites) {
          pending.pollsObserved++;
          const reg42Match = rawReg42000 === pending.expectedReg42000;
          const reg43Match = pending.expectedReg43000 === null
            ? true
            : rawReg43000 === pending.expectedReg43000;
          if (reg42Match && reg43Match) {
            const latencyMs = Date.now() - pending.writeStartedAt;
            this._pushModeEvent('write_acked', {
              seq: pending.seq,
              target_value: pending.target_value,
              polls_to_ack: pending.pollsObserved,
              latency_ms: latencyMs,
              raw_reg_43000: rawReg43000,
              raw_reg_42000: rawReg42000,
            });
            pending.matched = true;
          } else if (pending.pollsObserved >= 10) {
            // Give up after ~50s of polling at the default 5s interval. Record
            // the timeout so we still capture failed/laggy writes.
            this._pushModeEvent('write_timeout', {
              seq: pending.seq,
              target_value: pending.target_value,
              polls_observed: pending.pollsObserved,
              latency_ms: Date.now() - pending.writeStartedAt,
              raw_reg_43000: rawReg43000,
              raw_reg_42000: rawReg42000,
            });
          } else {
            this._pushModeEvent('poll_pending', {
              seq: pending.seq,
              poll_index: pending.pollsObserved,
              raw_reg_43000: rawReg43000,
              raw_reg_42000: rawReg42000,
            });
            stillPending.push(pending);
          }
        }
        this._pendingWorkModeWrites = stillPending;
      }

      // Only set capability if value changed to prevent unnecessary triggers
      const currentWorkMode = this.getCapabilityValue('user_work_mode');
      if (currentWorkMode !== workModeStr) {
        this.setCapabilityValue('user_work_mode', workModeStr).catch(this.error);
      }
      //Process charging status from operation mode
      this.processChargingStatus(modeStr);
      //Get current force SOC target
      const reg_force_soc = await this.modbus.readHoldingRegisters(slaveId, 42011, 1);
      const force_soc = ModbusClient.bufferToUint16(Buffer.concat(reg_force_soc));
      console.log('Force charge target: '+force_soc+'%')

      // Only set capability if value changed to prevent unnecessary triggers
      const currentForceTarget = this.getCapabilityValue('force_charge_target');
      if (currentForceTarget !== force_soc) {
        this.setCapabilityValue('force_charge_target', force_soc).catch(this.error);
      }
      //Get current backup mode
      const reg_backup_mode = await this.modbus.readHoldingRegisters(slaveId, 41200, 1);
      const backup_mode = ModbusClient.bufferToUint16(Buffer.concat(reg_backup_mode));
      const backupModeValue = (backup_mode==0);
      console.log('Backup Mode: '+backupModeValue)

      // Only set capability if value changed to prevent unnecessary triggers
      const currentBackupMode = this.getCapabilityValue('backup_mode');
      if (currentBackupMode !== backupModeValue) {
        this.setCapabilityValue('backup_mode', backupModeValue).catch(this.error);
      }

      // Read max charge power limit (register 44002) - device protection limit
      const reg_max_charge_power = await this.modbus.readHoldingRegisters(slaveId, 44002, 1);
      const max_charge_power = ModbusClient.bufferToUint16(Buffer.concat(reg_max_charge_power));
      console.log('Max charge power limit: ' + max_charge_power + 'W');

      // Only set capability if value changed to prevent unnecessary triggers
      const currentMaxChargePower = this.getCapabilityValue('max_charge_power_limit');
      if (currentMaxChargePower !== max_charge_power) {
        this.setCapabilityValue('max_charge_power_limit', max_charge_power).catch(this.error);
      }

      // Read max discharge power limit (register 44003) - device protection limit
      const reg_max_discharge_power = await this.modbus.readHoldingRegisters(slaveId, 44003, 1);
      const max_discharge_power = ModbusClient.bufferToUint16(Buffer.concat(reg_max_discharge_power));
      console.log('Max discharge power limit: ' + max_discharge_power + 'W');

      // Only set capability if value changed to prevent unnecessary triggers
      const currentMaxDischargePower = this.getCapabilityValue('max_discharge_power_limit');
      if (currentMaxDischargePower !== max_discharge_power) {
        this.setCapabilityValue('max_discharge_power_limit', max_discharge_power).catch(this.error);
      }

      // Sync target_power slider range to the device's current max charge/discharge
      // limits. Homey requires min<=0<=max, so guard against zeroed readings during
      // startup by falling back to the hardware ceiling (2500W).
      const targetMax = max_charge_power > 0 ? max_charge_power : 2500;
      const targetMin = -(max_discharge_power > 0 ? max_discharge_power : 2500);
      if (this._targetPowerMax !== targetMax || this._targetPowerMin !== targetMin) {
        try {
          await this.setCapabilityOptions('target_power', {
            min: targetMin,
            max: targetMax,
            step: 5,
          });
          this._targetPowerMin = targetMin;
          this._targetPowerMax = targetMax;
          this.log(`target_power range updated to [${targetMin}, ${targetMax}] W`);
        } catch (err) {
          this.log('Failed to update target_power range:', err.message);
        }
      }

      // Derive target_power from the force registers so Homey's standard
      // energy view reflects the requested setpoint (not the measured power,
      // which may differ due to SOC cutoffs or thermal limiting).
      let derivedTargetPower = 0;
      if (forceModeStr === 'force_charge') {
        derivedTargetPower = this.getCapabilityValue('force_charge_power') || 0;
      } else if (forceModeStr === 'force_discharge') {
        derivedTargetPower = -(this.getCapabilityValue('force_discharge_power') || 0);
      }
      const currentTargetPower = this.getCapabilityValue('target_power');
      if (currentTargetPower !== derivedTargetPower) {
        this.setCapabilityValue('target_power', derivedTargetPower).catch(this.error);
      }

      // target_power_mode mirrors user_work_mode 1:1, with control_mode → homey.
      const derivedTargetMode = (workModeStr === 'control_mode') ? 'homey' : workModeStr;
      const currentTargetMode = this.getCapabilityValue('target_power_mode');
      if (derivedTargetMode && currentTargetMode !== derivedTargetMode) {
        this.setCapabilityValue('target_power_mode', derivedTargetMode).catch(this.error);
      }

      // onoff is "off" only when Homey is in full control AND nothing is
      // actively driving the battery: target_power is 0 AND there is no
      // active force_soc SOC target. force_soc is a valid homey-control
      // strategy that should keep the switch shown as "on".
      const forceSocActive = displayForceMode === 'force_soc';
      const derivedOnOff = !(derivedTargetMode === 'homey' && derivedTargetPower === 0 && !forceSocActive);
      const currentOnOff = this.getCapabilityValue('onoff');
      if (currentOnOff !== derivedOnOff) {
        this.setCapabilityValue('onoff', derivedOnOff).catch(this.error);
      }
      if (derivedOnOff) {
        const activeMode = derivedTargetMode || 'anti_feed';
        if (this.getStoreValue('lastActiveMode') !== activeMode) {
          this.setStoreValue('lastActiveMode', activeMode).catch(this.error);
        }
        if (activeMode === 'homey' && derivedTargetPower !== 0) {
          this.setStoreValue('lastActivePower', derivedTargetPower).catch(this.error);
        }
      }

    } catch (error) {
      this.log('Error processing system data:', error);
    }
  }

  async processAlarmCodes(slaveId) {
    try {
      const alarms = [];
      const systemAlarms = [];
      const gridAlarms = [];
      const batteryAlarms = [];
      const hardwareAlarms = [];
      const systemFaultAlarms = [];
      let hasAlarm = false;

      // Default register values (assume no alarms if register doesn't exist)
      let alarm_code = 0;
      let grid_fault = 0;
      let battery_fault = 0;
      let hardware_fault = 0;

      // Try to read alarm code (36000) - System alarms
      try {
        const reg_alarm_code = await this.modbus.readHoldingRegisters(slaveId, 36000, 1);
        alarm_code = ModbusClient.bufferToUint16(Buffer.concat(reg_alarm_code));

        if (alarm_code > 0) {
          hasAlarm = true;
          if (alarm_code & 0x01) { alarms.push('PLL Abnormal Restart'); systemAlarms.push('PLL Abnormal Restart'); }
          if (alarm_code & 0x02) { alarms.push('Over Temperature Limit'); systemAlarms.push('Over Temperature Limit'); }
          if (alarm_code & 0x04) { alarms.push('Low Temperature Limit'); systemAlarms.push('Low Temperature Limit'); }
          if (alarm_code & 0x08) { alarms.push('Fan Abnormal Warning'); systemAlarms.push('Fan Abnormal Warning'); }
          if (alarm_code & 0x10) { alarms.push('Low Battery SOC Warning'); systemAlarms.push('Low Battery SOC Warning'); }
          if (alarm_code & 0x20) { alarms.push('Output Overcurrent Warning'); systemAlarms.push('Output Overcurrent Warning'); }
          if (alarm_code & 0x40) { alarms.push('Abnormal Line Sequence Detection'); systemAlarms.push('Abnormal Line Sequence Detection'); }
        }
      } catch (error) {
        this.log(`Alarm register 36000 not available: ${error.message}`);
      }

      // Try to read grid fault word (36100) - Grid faults
      try {
        const reg_grid_fault = await this.modbus.readHoldingRegisters(slaveId, 36100, 1);
        grid_fault = ModbusClient.bufferToUint16(Buffer.concat(reg_grid_fault));

        if (grid_fault > 0) {
          hasAlarm = true;
          if (grid_fault & 0x01) { alarms.push('Grid Overvoltage'); gridAlarms.push('Grid Overvoltage'); }
          if (grid_fault & 0x02) { alarms.push('Grid Undervoltage'); gridAlarms.push('Grid Undervoltage'); }
          if (grid_fault & 0x04) { alarms.push('Grid Overfrequency'); gridAlarms.push('Grid Overfrequency'); }
          if (grid_fault & 0x08) { alarms.push('Grid Underfrequency'); gridAlarms.push('Grid Underfrequency'); }
          if (grid_fault & 0x10) { alarms.push('Grid Peak Voltage Abnormal'); gridAlarms.push('Grid Peak Voltage Abnormal'); }
          if (grid_fault & 0x20) { alarms.push('Current Dcover'); gridAlarms.push('Current Dcover'); }
          if (grid_fault & 0x40) { alarms.push('Voltage Dcover'); gridAlarms.push('Voltage Dcover'); }
        }
      } catch (error) {
        this.log(`Grid fault register 36100 not available: ${error.message}`);
      }

      // Try to read battery fault word (36101) - Battery faults
      try {
        const reg_battery_fault = await this.modbus.readHoldingRegisters(slaveId, 36101, 1);
        battery_fault = ModbusClient.bufferToUint16(Buffer.concat(reg_battery_fault));

        if (battery_fault > 0) {
          hasAlarm = true;
          if (battery_fault & 0x01) { alarms.push('Battery Overvoltage'); batteryAlarms.push('Battery Overvoltage'); }
          if (battery_fault & 0x02) { alarms.push('Battery Undervoltage'); batteryAlarms.push('Battery Undervoltage'); }
          if (battery_fault & 0x04) { alarms.push('Battery Overcurrent'); batteryAlarms.push('Battery Overcurrent'); }
          if (battery_fault & 0x08) { alarms.push('Battery Low SOC'); batteryAlarms.push('Battery Low SOC'); }
          if (battery_fault & 0x10) { alarms.push('Battery Communication Failure'); batteryAlarms.push('Battery Communication Failure'); }
          if (battery_fault & 0x20) { alarms.push('BMS Protect'); batteryAlarms.push('BMS Protect'); }
        }
      } catch (error) {
        this.log(`Battery fault register 36101 not available: ${error.message}`);
      }

      // Try to read hardware fault word (36103) - Hardware faults
      try {
        const reg_hardware_fault = await this.modbus.readHoldingRegisters(slaveId, 36103, 1);
        hardware_fault = ModbusClient.bufferToUint16(Buffer.concat(reg_hardware_fault));

        if (hardware_fault > 0) {
          hasAlarm = true;
          if (hardware_fault & 0x001) { alarms.push('Hardware Bus Overvoltage'); hardwareAlarms.push('Hardware Bus Overvoltage'); }
          if (hardware_fault & 0x002) { alarms.push('Hardware Output Overcurrent'); hardwareAlarms.push('Hardware Output Overcurrent'); }
          if (hardware_fault & 0x004) { alarms.push('Hardware Trans Overcurrent'); hardwareAlarms.push('Hardware Trans Overcurrent'); }
          if (hardware_fault & 0x008) { alarms.push('Hardware Battery Overcurrent'); hardwareAlarms.push('Hardware Battery Overcurrent'); }
          if (hardware_fault & 0x010) { alarms.push('Hardware Protection'); hardwareAlarms.push('Hardware Protection'); }
          if (hardware_fault & 0x020) { alarms.push('Output Overcurrent'); hardwareAlarms.push('Output Overcurrent'); }
          if (hardware_fault & 0x040) { alarms.push('High Voltage Bus Overvoltage'); hardwareAlarms.push('High Voltage Bus Overvoltage'); }
          if (hardware_fault & 0x080) { alarms.push('High Voltage Bus Undervoltage'); hardwareAlarms.push('High Voltage Bus Undervoltage'); }
          if (hardware_fault & 0x100) { alarms.push('Overpower Protection'); hardwareAlarms.push('Overpower Protection'); }
          if (hardware_fault & 0x200) { alarms.push('FSM Abnormal'); hardwareAlarms.push('FSM Abnormal'); }
          if (hardware_fault & 0x400) { alarms.push('Overtemperature Protection'); hardwareAlarms.push('Overtemperature Protection'); }
          if (hardware_fault & 0x800) { alarms.push('Inverter Soft Start Timeout'); hardwareAlarms.push('Inverter Soft Start Timeout'); }
        }
      } catch (error) {
        this.log(`Hardware fault register 36103 not available: ${error.message}`);
      }

      // Register 36104 not available on this device - skipping system fault detection

      // Update alarm capability and set warning if needed
      const currentAlarm = this.getCapabilityValue('alarm_generic');
      if (currentAlarm !== hasAlarm) {
        this.setCapabilityValue('alarm_generic', hasAlarm).catch(this.error);
      }

      // Set warning with specific alarm details and trigger workflow cards
      if (hasAlarm && alarms.length > 0) {
        const alarmMessage = `Device alarms detected: ${alarms.join(', ')}`;
        const alarmCodes = `System:${alarm_code},Grid:${grid_fault},Battery:${battery_fault},Hardware:${hardware_fault}`;

        this.setWarning(alarmMessage);
        this.log(`Alarms detected: ${alarmMessage}`);

        // Trigger general battery fault detected event with tokens
        this.homey.flow.getDeviceTriggerCard('battery_fault_detected')
          .trigger(this,
            { message: alarmMessage, alarm_codes: alarmCodes },
            {}
          )
          .catch(this.error);

        // Trigger specific alarm type events with detailed messages for available registers
        if (gridAlarms.length > 0) {
          const gridMessage = gridAlarms.join(', ');
          this.homey.flow.getDeviceTriggerCard('grid_fault_detected')
            .trigger(this, { message: gridMessage }, {})
            .catch(this.error);
        }

        if (batteryAlarms.length > 0) {
          const batteryMessage = batteryAlarms.join(', ');
          this.homey.flow.getDeviceTriggerCard('battery_system_fault_detected')
            .trigger(this, { message: batteryMessage }, {})
            .catch(this.error);
        }

        if (hardwareAlarms.length > 0) {
          const hardwareMessage = hardwareAlarms.join(', ');
          this.homey.flow.getDeviceTriggerCard('hardware_fault_detected')
            .trigger(this, { message: hardwareMessage }, {})
            .catch(this.error);
        }

        // Use generic battery warning for system alarms (since specific system fault register isn't available)
        if (systemAlarms.length > 0) {
          const warningMessage = systemAlarms.join(', ');
          this.homey.flow.getDeviceTriggerCard('battery_warning_detected')
            .trigger(this,
              { message: warningMessage, alarm_codes: alarmCodes },
              {}
            )
            .catch(this.error);
        }
      } else if (!hasAlarm) {
        // Clear warning when no alarms
        this.unsetWarning();
      }

    } catch (error) {
      this.log('Error processing alarm codes:', error);
    }
  }

  processChargingStatus(operationMode) {
    // Determine charging status based on operation mode
    // Standard battery_charging_state values: charging, discharging, idle
    let chargingStatus = 'idle';

    if (operationMode && operationMode.toLowerCase().includes('discharge')) {
      chargingStatus = 'discharging';
    } else if (operationMode && operationMode.toLowerCase().includes('charge')) {
      chargingStatus = 'charging';
    }

    // Only set capability if value changed to prevent unnecessary triggers
    const previousStatus = this.getCapabilityValue('battery_charging_state');
    if (previousStatus !== chargingStatus) {
      this.setCapabilityValue('battery_charging_state', chargingStatus).catch(this.error);

      // Trigger charging status change events
      this.homey.flow.getDeviceTriggerCard('charging_status_changed')
        .trigger(this, { status: chargingStatus }, { status: chargingStatus })
        .catch(this.error);

      if (chargingStatus === 'charging') {
        this.homey.flow.getDeviceTriggerCard('battery_started_charging')
          .trigger(this, {}, {})
          .catch(this.error);
      } else if (chargingStatus === 'discharging') {
        this.homey.flow.getDeviceTriggerCard('battery_started_discharging')
          .trigger(this, {}, {})
          .catch(this.error);
      }
    }
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

  validateControlRequirement()
  {
    return new Promise((resolve, reject) => {
      const currentChargeMode = this.getCapabilityValue('user_work_mode');
      if(currentChargeMode!=='control_mode')
      {
        this.setWarning('These controls only work in force control mode');
        return reject(new Error('Failed to set charge mode'));
      } else {
        resolve("Modbus control mode is enabled, proceed");
      }
    });  
  }

  async onCapabilityBackupMode(value, opts = {}) {
    try {
      if (!await this.connectModbus()) {
        throw new Error('Modbus connection failed');
      }
      
      const slaveId = this.settings.slave_id || 1;
      await this.modbus.writeSingleRegister(slaveId, 41200, (value ? 0 : 1));
      this.log('Backup mode set to: '+value+', now trigger the worklow card:');

      // Update the capability value to log the change in insights/timeline
      await this.setCapabilityValue('backup_mode', value);

      if (this.backupModeChangedTrigger && !opts.fromCloudSync) {
        await this.backupModeChangedTrigger.trigger(this,
          { mode: value },
          { mode: value.toString() }
        );
      }
    } catch (error) {
      this.log('Error setting backup mode:', error);
      throw new Error('Failed to backup mode');
    }   
  }

  // Write operations for supported registers
  async onCapabilityForceChargePower(value, opts = {}) {
    try {
      if (!await this.connectModbus()) {
        throw new Error('Modbus connection failed');
      }
      
      const slaveId = this.settings.slave_id || 1;
      await this.modbus.writeSingleRegister(slaveId, 42020, Math.round(value));
      this.log('Force charge power set to:'+value+' and trigger the workflow');

      // Update the capability value to reflect the change in UI
      await this.setCapabilityValue('force_charge_power', Math.round(value));

      if (this.forceChargePowerChangedTrigger && !opts.fromCloudSync) {
        await this.forceChargePowerChangedTrigger.trigger(this,
          { power: value },
          { power: value }
        );
      }
    } catch (error) {
      this.log('Error setting force charge power:', error);
      throw new Error('Failed to set force charge power');
    }
  }

  async onCapabilityForceDisChargePower(value, opts = {}) {
    try {
      if (!await this.connectModbus()) {
        throw new Error('Modbus connection failed');
      }
      
      const slaveId = this.settings.slave_id || 1;
      await this.modbus.writeSingleRegister(slaveId, 42021, Math.round(value));
      this.log('Force discharge power set to: '+value+', now trigger flow cards');

      // Update the capability value to reflect the change in UI
      await this.setCapabilityValue('force_discharge_power', Math.round(value));

      if (this.forceDischargePowerChangedTrigger && !opts.fromCloudSync) {
        await this.forceDischargePowerChangedTrigger.trigger(this,
          { power: value },
          { power: value }
        );
      }
    } catch (error) {
      this.log('Error setting force discharge power:', error);
      throw new Error('Failed to set force discharge power');
    }
  }

  async onCapabilityChargeMode(value, opts = {}) {
    try {
      if (!await this.connectModbus()) {
        throw new Error('Modbus connection failed');
      }

      // Any force_* mode implies homey-driven control: auto-flip instead of
      // refusing the request when the battery is still in an autonomous mode.
      const wantsHomeyControl = value === 'force_charge' || value === 'force_discharge'
        || value === 'force_soc' || value === 'target_power';
      if (wantsHomeyControl && this.getCapabilityValue('target_power_mode') !== 'homey') {
        this.log(`force_charge_mode=${value} requested while not in homey mode - switching`);
        await this.onCapabilityTargetPowerMode('homey');
      }

      const slaveId = this.settings.slave_id || 1;

      // force_soc is a Homey-only mode - on hardware it is triggered by setting a SOC target on register 42011
      if (value === 'force_soc') {
        this.log('Force SOC mode selected - writing current SOC target to register 42011');
        const currentTarget = this.getCapabilityValue('force_charge_target') || 25;
        await this.modbus.writeSingleRegister(slaveId, 42011, currentTarget);
        // Reflect the master switch "on" immediately rather than waiting for poll.
        await this.setCapabilityValue('onoff', true).catch(this.error);
        await this.setStoreValue('lastActiveMode', 'homey');
      } else if (value === 'target_power') {
        // target_power is also a Homey-only umbrella label: re-apply the current
        // target_power setpoint so the hardware registers match the picker state.
        const currentTargetPower = this.getCapabilityValue('target_power') || 0;
        this.log(`target_power mode selected via picker - re-applying ${currentTargetPower}W`);
        await this.onCapabilityTargetPower(currentTargetPower, { fromCloudSync: true });
      } else {
        const modeValue = Object.keys(this.driver.FORCE_MODES).find(
          key => this.driver.FORCE_MODES[key] === value
        );
        console.log('Attempt to set mode to '+modeValue+' based on '+value);
        //We expect the work mode to be on force_control, else this is ignored
        await this.modbus.writeSingleRegister(slaveId, 42010, parseInt(modeValue));
      }
      this.log('Charge mode set to:', value);

      // Apply configurable delay to allow battery to accept new state
      const delay = this.settings.force_mode_delay || 1000;
      if (delay > 0) {
        this.log(`Waiting ${delay}ms for battery to accept force mode change...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      // Update the capability value to log the change in insights/timeline
      await this.setCapabilityValue('force_charge_mode', value);

      //Now trigger the workflow card
      if (this.forceChargeModeChangedTrigger && !opts.fromCloudSync) {
        await this.forceChargeModeChangedTrigger.trigger(this,
          { mode: value },
          { mode: value }
        );
      }

    } catch (error) {
      this.log('Error setting charge mode:', error);
      throw new Error('Failed to set charge mode');
    }
  }

  //Sets the User Work Mode by turning the device in on eof the three automated operating modes
  //If the force control mode is selected it will turn on modbus control to allow the charge value to lead the bahavior
  async onCapabilityUserWorkMode(value, opts = {}) {
    try {
      // Guard against spurious refresh-writes from the mobile/desktop Homey app,
      // which sometimes re-emits a cached capability value when the user just
      // opens the device view. Without this check, such a refresh would flip
      // 42000 back to 21947 and drop us out of control_mode.
      if (this.getCapabilityValue('user_work_mode') === value) {
        this.log(`user_work_mode already ${value}, skipping redundant write`);
        return;
      }

      if (!await this.connectModbus()) {
        throw new Error('Modbus connection failed');
      }

      const slaveId = this.settings.slave_id || 1;
      const userWorkValue = Object.keys(this.driver.WORK_MODES).find(
        key => this.driver.WORK_MODES[key] === value
      );
      console.log('Attempt to set Work mode to '+userWorkValue+' based on '+value);
      // Diagnostic: record the write intent + parameters so we can correlate
      // with subsequent polls and measure write→stable-read latency.
      const writeStartedAt = Date.now();
      const writeEvent = this._pushModeEvent('write_start', {
        slave_id: slaveId,
        target_value: value,
        target_register_43000: parseInt(userWorkValue),
        target_register_42000: (userWorkValue == 3) ? 21930 : 21947,
        caller: opts.fromCloudSync ? 'cloud_sync' : 'local',
      });
      const expectedReg43000 = (userWorkValue == 3)
        ? null  // control_mode does not write 43000; observe via 42000=21930
        : parseInt(userWorkValue);
      const expectedReg42000 = (userWorkValue == 3) ? 21930 : 21947;

      // Any in-flight pending writes are about to be overwritten by this one,
      // so they can never observe their original target. Record them as
      // superseded (with how far they got) and drop them — otherwise they'd
      // poll until timeout and pollute the latency distribution.
      for (const old of this._pendingWorkModeWrites) {
        this._pushModeEvent('write_superseded', {
          seq: old.seq,
          target_value: old.target_value,
          superseded_by_seq: writeEvent.seq,
          polls_observed: old.pollsObserved,
          latency_ms: Date.now() - old.writeStartedAt,
        });
      }
      this._pendingWorkModeWrites = [];

      this._pendingWorkModeWrites.push({
        seq: writeEvent.seq,
        writeStartedAt,
        target_value: value,
        expectedReg43000,
        expectedReg42000,
        pollsObserved: 0,
        matched: false,
      });

      if(userWorkValue==3)
      {
        this.log('We set the modbus control flag to true');
        //Turn on modbus control mode
        await this.modbus.writeSingleRegister(slaveId, 42000, 21930);
      } else {
        this.log('We set the modbus control mode to off');
        await this.setCapabilityValue('force_charge_mode','none');
        //Turn off the modbus control mode
        this.log('We set the modbus control flag to false');
        await this.modbus.writeSingleRegister(slaveId, 42000, 21947);
        //Now set the device to the right work mode
        this.log('We set the new work value');
        await this.modbus.writeSingleRegister(slaveId, 43000, userWorkValue);
      }

      // Diagnostic: record write completion. The duration is purely the
      // Modbus round-trip — NOT the time until the device exposes the new
      // value via reads. That latency is computed on the next poll match.
      this._pushModeEvent('write_done', {
        seq: writeEvent.seq,
        duration_ms: Date.now() - writeStartedAt,
      });
      this.log('Work mode set to:'+value+', now trigger the workflow card');

      // Update the capability value to log the change in insights/timeline
      await this.setCapabilityValue('user_work_mode', value);

      // Keep target_power_mode in sync with the picker without waiting for the next poll.
      const mirrored = (value === 'control_mode') ? 'homey' : value;
      await this.setCapabilityValue('target_power_mode', mirrored).catch(this.error);

      if (this.userWorkModeChangedTrigger && !opts.fromCloudSync) {
        await this.userWorkModeChangedTrigger.trigger(this,
          { mode: value },
          { mode: value }
        );
      }

    } catch (error) {
      this.log('Error setting work mode:', error);
      throw new Error('Failed to set work mode');
    }
  }

  // Master on/off switch. OFF forces the battery to idle under Homey control
  // (target_power_mode=homey, target_power=0). ON restores the last active
  // non-idle mode (stored in device-store) or falls back to anti_feed.
  async onCapabilityOnoff(value, opts = {}) {
    try {
      if (this.getCapabilityValue('onoff') === value) {
        this.log(`onoff already ${value}, skipping redundant write`);
        return;
      }

      if (value === false) {
        await this.onCapabilityTargetPowerMode('homey');
        await this.onCapabilityTargetPower(0);
      } else {
        const lastActive = this.getStoreValue('lastActiveMode') || 'anti_feed';
        if (lastActive === 'homey') {
          // Previous active state was Homey-controlled with a non-zero setpoint.
          const lastPower = this.getStoreValue('lastActivePower') || 0;
          await this.onCapabilityTargetPowerMode('homey');
          if (lastPower !== 0) {
            await this.onCapabilityTargetPower(lastPower);
          }
        } else {
          await this.onCapabilityTargetPowerMode(lastActive);
        }
      }

      await this.setCapabilityValue('onoff', value).catch(this.error);
      this.log(`onoff set to ${value}`);
    } catch (error) {
      this.log('Error setting onoff:', error);
      throw new Error('Failed to set onoff');
    }
  }

  // Homey standard energy capability: positive = charge, negative = discharge, 0 = idle.
  // Translates to the Marstek force-mode + force_*_power registers and ensures
  // RS485 control is active so the request actually takes effect.
  async onCapabilityTargetPower(value, opts = {}) {
    try {
      if (!await this.connectModbus()) {
        throw new Error('Modbus connection failed');
      }

      const slaveId = this.settings.slave_id || 1;
      const power = Math.round(Number(value) || 0);

      // Ensure RS485 / control mode is active so force registers are honored.
      if (this.getCapabilityValue('user_work_mode') !== 'control_mode') {
        this.log('target_power requested while not in control_mode - enabling RS485 control');
        await this.modbus.writeSingleRegister(slaveId, 42000, 21930);
        await this.setCapabilityValue('user_work_mode', 'control_mode').catch(this.error);
      }

      // target_power and force_soc are mutually exclusive force strategies, but
      // on the Marstek force_soc is driven by its own register (42011 SOC target)
      // that keeps running until overwritten — writing 42010 alone does NOT
      // cancel it. Only neutralize 42011 when force_soc was actually active, to
      // avoid the extra Modbus roundtrip on every normal target_power write.
      const currentForceMode = this.getCapabilityValue('force_charge_mode');
      const currentSocTarget = this.getCapabilityValue('force_charge_target');
      const currentSoc = this.getCapabilityValue('measure_battery');
      const socTargetDrift = typeof currentSocTarget === 'number'
        && typeof currentSoc === 'number'
        && Math.abs(currentSocTarget - currentSoc) > 1;
      if ((currentForceMode === 'force_soc' || socTargetDrift)
          && typeof currentSoc === 'number' && currentSoc > 0) {
        const clampedSoc = Math.max(11, Math.min(100, Math.round(currentSoc)));
        await this.modbus.writeSingleRegister(slaveId, 42011, clampedSoc);
        this.log(`Neutralized force_soc by writing current SOC (${clampedSoc}%) to 42011`);
      }

      let newForceMode = 'none';
      if (power > 0) {
        const charge = Math.min(2500, power);
        await this.modbus.writeSingleRegister(slaveId, 42020, charge);
        await this.modbus.writeSingleRegister(slaveId, 42010, 1); // force_charge
        newForceMode = 'target_power';
        await this.setCapabilityValue('force_charge_power', charge).catch(this.error);
      } else if (power < 0) {
        const discharge = Math.min(2500, Math.abs(power));
        await this.modbus.writeSingleRegister(slaveId, 42021, discharge);
        await this.modbus.writeSingleRegister(slaveId, 42010, 2); // force_discharge
        newForceMode = 'target_power';
        await this.setCapabilityValue('force_discharge_power', discharge).catch(this.error);
      } else {
        await this.modbus.writeSingleRegister(slaveId, 42010, 0); // none / idle
      }

      // Let the hardware settle before we claim success.
      const delay = this.settings.force_mode_delay || 1000;
      if (delay > 0) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      await this.setCapabilityValue('force_charge_mode', newForceMode).catch(this.error);
      await this.setCapabilityValue('target_power', power).catch(this.error);
      await this.setCapabilityValue('target_power_mode', 'homey').catch(this.error);

      // A non-zero setpoint means the battery is actively doing work.
      // Reflect that on the master switch and remember it for "on" restores.
      if (power !== 0) {
        await this.setCapabilityValue('onoff', true).catch(this.error);
        await this.setStoreValue('lastActiveMode', 'homey');
        await this.setStoreValue('lastActivePower', power);
      } else {
        await this.setCapabilityValue('onoff', false).catch(this.error);
      }

      this.log(`target_power set to ${power}W (mode=${newForceMode})`);
    } catch (error) {
      this.log('Error setting target_power:', error);
      throw new Error('Failed to set target_power');
    }
  }

  // target_power_mode is the unified picker for the Marstek's four operating
  // strategies. 'homey' enables RS485 force-control so target_power and
  // force_soc actually take effect; the other three hand control back to the
  // battery's autonomous modes. Maps 1:1 onto user_work_mode.
  async onCapabilityTargetPowerMode(value, opts = {}) {
    try {
      // Idempotency guard against stale refresh-writes from the mobile app.
      if (this.getCapabilityValue('target_power_mode') === value) {
        this.log(`target_power_mode already ${value}, skipping redundant write`);
        return;
      }

      const workModeByTargetMode = {
        homey: 'control_mode',
        manual: 'manual',
        anti_feed: 'anti_feed',
        trade_mode: 'trade_mode',
      };
      const targetWorkMode = workModeByTargetMode[value];
      if (!targetWorkMode) {
        throw new Error(`Unsupported target_power_mode: ${value}`);
      }

      await this.onCapabilityUserWorkMode(targetWorkMode);

      if (value !== 'homey') {
        await this.setCapabilityValue('target_power', 0).catch(this.error);
      }

      await this.setCapabilityValue('target_power_mode', value).catch(this.error);

      // Any non-homey mode is an autonomous "on" state. Homey mode is only "on"
      // when a setpoint is actively driving the battery; without one it's idle.
      if (value !== 'homey') {
        await this.setCapabilityValue('onoff', true).catch(this.error);
        await this.setStoreValue('lastActiveMode', value);
      } else if ((this.getCapabilityValue('target_power') || 0) === 0) {
        await this.setCapabilityValue('onoff', false).catch(this.error);
      }

      this.log(`target_power_mode set to ${value}`);
    } catch (error) {
      this.log('Error setting target_power_mode:', error);
      throw new Error('Failed to set target_power_mode');
    }
  }

  async onCapabilityForceChargeTarget(value, opts = {}) {
    try {
      if (!await this.connectModbus()) {
        throw new Error('Modbus connection failed');
      }

      // Setting a SOC target is intrinsically a force-control action, so
      // auto-switch to homey mode instead of requiring the user to enable
      // control_mode separately.
      if (this.getCapabilityValue('target_power_mode') !== 'homey') {
        this.log('force_charge_target changed while not in homey mode - switching to homey');
        await this.onCapabilityTargetPowerMode('homey');
      }

      const slaveId = this.settings.slave_id || 1;
      //Set the force SOC Target for forced charge/discharge
      await this.setCapabilityValue('force_charge_mode','force_soc');
      await this.modbus.writeSingleRegister(slaveId, 42011, value);
      this.log('Set the force SOC target to '+value+', now trigger the workflow')

      // Update the capability value to reflect the change in UI
      await this.setCapabilityValue('force_charge_target', value);

      // force_soc is an active homey-control strategy, so the master switch
      // should reflect "on" immediately rather than wait for next poll.
      await this.setCapabilityValue('onoff', true).catch(this.error);
      await this.setStoreValue('lastActiveMode', 'homey');

      if (this.forceChargeTargetChangedTrigger && !opts.fromCloudSync) {
        await this.forceChargeTargetChangedTrigger.trigger(this,
          { target: value },
          { target: value }
        );
      }
    } catch (error) {
      this.log('Error setting force SOC target:', error);
      throw new Error('Failed to force SOC target');
    }
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


  async onDeleted() {
    this.log('VenusBatteryDevice deleted');
    // Set flag immediately to prevent any pending poll operations
    this._isDeleted = true;
    this.stopPolling();
    this.disconnectModbus();
  }

  // ============================================
  // CONDITION METHODS
  // ============================================

  /**
   * Check if backup mode matches the specified state
   * @param {Object} args - Flow card arguments
   * @param {string} args.mode - "true" or "false" as string
   * @returns {boolean} - True if condition matches
   */
  async conditionBackupModeIs(args) {
    try {
      const currentMode = this.getCapabilityValue('backup_mode');
      const targetMode = args.mode === 'true';
      
      this.log(`Checking backup mode: current=${currentMode}, target=${targetMode}`);
      return currentMode === targetMode;
    } catch (error) {
      this.error('Error checking backup mode condition:', error);
      return false;
    }
  }

  /**
   * Check if force charge mode matches the specified mode
   * @param {Object} args - Flow card arguments
   * @param {string} args.mode - Mode ID (none, force_charge, force_discharge, force_soc)
   * @returns {boolean} - True if condition matches
   */
  async conditionForceChargeModeIs(args) {
    try {
      const currentMode = this.getCapabilityValue('force_charge_mode');
      
      this.log(`Checking force charge mode: current=${currentMode}, target=${args.mode}`);
      return currentMode === args.mode;
    } catch (error) {
      this.error('Error checking force charge mode condition:', error);
      return false;
    }
  }

  /**
   * Check if user work mode matches the specified mode
   * @param {Object} args - Flow card arguments
   * @param {string} args.mode - Mode ID (manual, anti_feed, trade_mode, control_mode)
   * @returns {boolean} - True if condition matches
   */
  async conditionUserWorkModeIs(args) {
    try {
      const currentMode = this.getCapabilityValue('user_work_mode');
      
      this.log(`Checking user work mode: current=${currentMode}, target=${args.mode}`);
      return currentMode === args.mode;
    } catch (error) {
      this.error('Error checking user work mode condition:', error);
      return false;
    }
  }

  /**
   * Check if force charge power is greater than threshold
   * @param {Object} args - Flow card arguments
   * @param {number} args.power - Power threshold in watts
   * @returns {boolean} - True if current power is greater than threshold
   */
  async conditionForceChargePowerGreaterThan(args) {
    try {
      const currentPower = this.getCapabilityValue('force_charge_power') || 0;
      const threshold = Number(args.power);
      
      this.log(`Checking force charge power: current=${currentPower}W, threshold=${threshold}W`);
      return currentPower > threshold;
    } catch (error) {
      this.error('Error checking force charge power condition:', error);
      return false;
    }
  }

  /**
   * Check if force discharge power is greater than threshold
   * @param {Object} args - Flow card arguments
   * @param {number} args.power - Power threshold in watts
   * @returns {boolean} - True if current power is greater than threshold
   */
  async conditionForceDischargePowerGreaterThan(args) {
    try {
      const currentPower = this.getCapabilityValue('force_discharge_power') || 0;
      const threshold = Number(args.power);
      
      this.log(`Checking force discharge power: current=${currentPower}W, threshold=${threshold}W`);
      return currentPower > threshold;
    } catch (error) {
      this.error('Error checking force discharge power condition:', error);
      return false;
    }
  }

  /**
   * Check if force charge target is greater than threshold
   * @param {Object} args - Flow card arguments
   * @param {number} args.target - SOC threshold in percentage
   * @returns {boolean} - True if current target is greater than threshold
   */
  async conditionForceChargeTargetGreaterThan(args) {
    try {
      const currentTarget = this.getCapabilityValue('force_charge_target') || 0;
      const threshold = Number(args.target);

      this.log(`Checking force charge target: current=${currentTarget}%, threshold=${threshold}%`);
      return currentTarget > threshold;
    } catch (error) {
      this.error('Error checking force charge target condition:', error);
      return false;
    }
  }

  /**
   * Check if max charge power limit is below threshold
   * @param {Object} args - Flow card arguments
   * @param {number} args.power - Power threshold in watts
   * @returns {boolean} - True if current limit is below threshold
   */
  async conditionMaxChargePowerLimitBelow(args) {
    try {
      const currentLimit = this.getCapabilityValue('max_charge_power_limit') || 0;
      const threshold = Number(args.power);

      this.log(`Checking max charge power limit: current=${currentLimit}W, threshold=${threshold}W`);
      return currentLimit < threshold;
    } catch (error) {
      this.error('Error checking max charge power limit condition:', error);
      return false;
    }
  }

  /**
   * Check if max discharge power limit is below threshold
   * @param {Object} args - Flow card arguments
   * @param {number} args.power - Power threshold in watts
   * @returns {boolean} - True if current limit is below threshold
   */
  async conditionMaxDischargePowerLimitBelow(args) {
    try {
      const currentLimit = this.getCapabilityValue('max_discharge_power_limit') || 0;
      const threshold = Number(args.power);

      this.log(`Checking max discharge power limit: current=${currentLimit}W, threshold=${threshold}W`);
      return currentLimit < threshold;
    } catch (error) {
      this.error('Error checking max discharge power limit condition:', error);
      return false;
    }
  }

  /**
   * Check if charging cutoff SOC is above threshold
   * @param {Object} args - Flow card arguments
   * @param {number} args.percentage - SOC threshold in percentage
   * @returns {boolean} - True if current setting is above threshold
   */
  async conditionChargingCutoffSocAbove(args) {
    try {
      const currentSoc = this.getSetting('charging_cutoff_soc') || 100;
      const threshold = Number(args.percentage);

      this.log(`Checking charging cutoff SOC: current=${currentSoc}%, threshold=${threshold}%`);
      return currentSoc > threshold;
    } catch (error) {
      this.error('Error checking charging cutoff SOC condition:', error);
      return false;
    }
  }

  /**
   * Check if discharging cutoff SOC is above threshold
   * @param {Object} args - Flow card arguments
   * @param {number} args.percentage - SOC threshold in percentage
   * @returns {boolean} - True if current setting is above threshold
   */
  async conditionDischargingCutoffSocAbove(args) {
    try {
      const currentSoc = this.getSetting('discharging_cutoff_soc') || 15;
      const threshold = Number(args.percentage);

      this.log(`Checking discharging cutoff SOC: current=${currentSoc}%, threshold=${threshold}%`);
      return currentSoc > threshold;
    } catch (error) {
      this.error('Error checking discharging cutoff SOC condition:', error);
      return false;
    }
  }

  // ============================================
  // ACTION METHODS
  // ============================================

  /**
   * Set backup mode on or off
   * @param {Object} args - Flow card arguments
   * @param {string} args.mode - "true" or "false" as string
   * @returns {boolean} - Success status
   */
  async actionSetBackupMode(args) {
    try {
      const targetMode = args.mode === 'true';

      this.log(`Setting backup mode to: ${targetMode}`);
      await this.onCapabilityBackupMode(targetMode);

      return true;
    } catch (error) {
      this.error('Error setting backup mode:', error);
      throw error;
    }
  }

  /**
   * Set force charge mode
   * @param {Object} args - Flow card arguments
   * @param {string} args.mode - Mode ID (none, force_charge, force_discharge, force_soc)
   * @returns {boolean} - Success status
   */
  async actionSetForceChargeMode(args) {
    try {
      this.log(`Setting force charge mode to: ${args.mode}`);
      await this.onCapabilityChargeMode(args.mode);

      return true;
    } catch (error) {
      this.error('Error setting force charge mode:', error);
      throw error;
    }
  }

  /**
   * Set user work mode
   * @param {Object} args - Flow card arguments
   * @param {string} args.mode - Mode ID (manual, anti_feed, trade_mode, control_mode)
   * @returns {boolean} - Success status
   */
  async actionSetUserWorkMode(args) {
    try {
      this.log(`Setting user work mode to: ${args.mode}`);
      await this.onCapabilityUserWorkMode(args.mode);

      return true;
    } catch (error) {
      this.error('Error setting user work mode:', error);
      throw error;
    }
  }

  /**
   * Set force charge power
   * @param {Object} args - Flow card arguments
   * @param {number} args.power - Power setting in watts (0-2500)
   * @returns {boolean} - Success status
   */
  async actionSetForceChargePower(args) {
    try {
      const power = Number(args.power);

      // Validate range
      if (power < 0 || power > 2500) {
        throw new Error(`Invalid power value: ${power}W. Must be between 0-2500W`);
      }

      this.log(`Setting force charge power to: ${power}W`);
      await this.onCapabilityForceChargePower(power);

      return true;
    } catch (error) {
      this.error('Error setting force charge power:', error);
      throw error;
    }
  }

  /**
   * Set force discharge power
   * @param {Object} args - Flow card arguments
   * @param {number} args.power - Power setting in watts (0-2500)
   * @returns {boolean} - Success status
   */
  async actionSetForceDischargePower(args) {
    try {
      const power = Number(args.power);

      // Validate range
      if (power < 0 || power > 2500) {
        throw new Error(`Invalid power value: ${power}W. Must be between 0-2500W`);
      }

      this.log(`Setting force discharge power to: ${power}W`);
      await this.onCapabilityForceDisChargePower(power);

      return true;
    } catch (error) {
      this.error('Error setting force discharge power:', error);
      throw error;
    }
  }

  /**
   * Set force charge target (SOC)
   * @param {Object} args - Flow card arguments
   * @param {number} args.target - SOC target in percentage (11-100)
   * @returns {boolean} - Success status
   */
  async actionSetForceChargeTarget(args) {
    try {
      const target = Number(args.target);

      // Validate range
      if (target < 11 || target > 100) {
        throw new Error(`Invalid SOC target: ${target}%. Must be between 11-100%`);
      }

      this.log(`Setting force charge target to: ${target}%`);
      await this.onCapabilityForceChargeTarget(target);

      return true;
    } catch (error) {
      this.error('Error setting force charge target:', error);
      throw error;
    }
  }

  /**
   * Set charging cutoff SOC via flow action
   * @param {Object} args - Flow card arguments
   * @param {number} args.percentage - SOC percentage (40-100)
   * @returns {boolean} - Success status
   */
  async actionSetChargingCutoffSoc(args) {
    try {
      const percentage = Number(args.percentage);

      // Validate range
      if (percentage < 40 || percentage > 100) {
        throw new Error(`Invalid charging cutoff SOC: ${percentage}%. Must be between 40-100%`);
      }

      this.log(`Setting charging cutoff SOC to: ${percentage}%`);
      await this.setChargingCutoffSoc(percentage);

      // Update the setting value
      await this.setSettings({ 'charging_cutoff_soc': percentage });

      return true;
    } catch (error) {
      this.error('Error setting charging cutoff SOC:', error);
      throw error;
    }
  }

  /**
   * Set discharging cutoff SOC via flow action
   * @param {Object} args - Flow card arguments
   * @param {number} args.percentage - SOC percentage (12-30)
   * @returns {boolean} - Success status
   */
  async actionSetDischargingCutoffSoc(args) {
    try {
      const percentage = Number(args.percentage);

      // Validate range
      if (percentage < 12 || percentage > 30) {
        throw new Error(`Invalid discharging cutoff SOC: ${percentage}%. Must be between 12-30%`);
      }

      this.log(`Setting discharging cutoff SOC to: ${percentage}%`);
      await this.setDischargingCutoffSoc(percentage);

      // Update the setting value
      await this.setSettings({ 'discharging_cutoff_soc': percentage });

      return true;
    } catch (error) {
      this.error('Error setting discharging cutoff SOC:', error);
      throw error;
    }
  }

  // ============================================
  // MODBUS WRITE METHODS FOR CUTOFF SOC
  // ============================================

  /**
   * Write charging cutoff SOC to Modbus register 44000
   * @param {number} percentage - SOC percentage (will be clamped to 40-100)
   */
  async setChargingCutoffSoc(percentage) {
    try {
      if (!await this.connectModbus()) {
        throw new Error('Modbus connection failed');
      }

      // Clamp to valid write range (40-100%)
      const clampedPercentage = Math.min(100, Math.max(40, percentage));
      if (clampedPercentage !== percentage) {
        this.log(`Charging cutoff SOC ${percentage}% clamped to ${clampedPercentage}%`);
      }

      const slaveId = this.settings.slave_id || 1;
      // Register 44000 uses 0.1% resolution, so multiply by 10
      const registerValue = Math.round(clampedPercentage * 10);

      this.log(`Writing charging cutoff SOC: ${clampedPercentage}% (register value: ${registerValue}) to register 44000`);
      // Enable RS485 control before writing to register
      await this.modbus.writeSingleRegister(slaveId, 42000, 21930);
      await this.modbus.writeSingleRegister(slaveId, 44000, registerValue);

      this.log('Charging cutoff SOC written successfully');
    } catch (error) {
      this.error('Error writing charging cutoff SOC to Modbus:', error);
      throw error;
    }
  }

  /**
   * Write discharging cutoff SOC to Modbus register 44001
   * @param {number} percentage - SOC percentage (will be clamped to 12-30)
   */
  async setDischargingCutoffSoc(percentage) {
    try {
      if (!await this.connectModbus()) {
        throw new Error('Modbus connection failed');
      }

      // Clamp to valid write range (12-30%)
      const clampedPercentage = Math.min(30, Math.max(12, percentage));
      if (clampedPercentage !== percentage) {
        this.log(`Discharging cutoff SOC ${percentage}% clamped to ${clampedPercentage}%`);
      }

      const slaveId = this.settings.slave_id || 1;
      // Register 44001 uses 0.1% resolution, so multiply by 10
      const registerValue = Math.round(clampedPercentage * 10);

      this.log(`Writing discharging cutoff SOC: ${clampedPercentage}% (register value: ${registerValue}) to register 44001`);
      // Enable RS485 control before writing to register
      await this.modbus.writeSingleRegister(slaveId, 42000, 21930);
      await this.modbus.writeSingleRegister(slaveId, 44001, registerValue);

      this.log('Discharging cutoff SOC written successfully');
    } catch (error) {
      this.error('Error writing discharging cutoff SOC to Modbus:', error);
      throw error;
    }
  }

  // ============================================
  // TRIGGER REGISTRATION
  // ============================================

  /**
   * Register flow card triggers in your device's onInit method
   */
  registerFlowCardTriggers() {
    // Register device-specific trigger cards

    this.forceChargeModeChangedTrigger = this.homey.flow.getDeviceTriggerCard('force_charge_mode_changed');
    this.operationModeChangedTrigger = this.homey.flow.getDeviceTriggerCard('operation_mode_changed');
    this.userWorkModeChangedTrigger = this.homey.flow.getDeviceTriggerCard('user_work_mode_changed');
    this.forceChargePowerChangedTrigger = this.homey.flow.getDeviceTriggerCard('force_charge_power_changed');
    this.forceDischargePowerChangedTrigger = this.homey.flow.getDeviceTriggerCard('force_discharge_power_changed');
    this.forceChargeTargetChangedTrigger = this.homey.flow.getDeviceTriggerCard('force_charge_target_changed');
    
    this.log('Flow card triggers registered');
  }

  // ============================================
  // CAPABILITY CHANGE LISTENERS
  // ============================================

  /**
   * Set up capability change listeners to trigger flow cards automatically
   * Call this in your device's onInit method
   */
  setupCapabilityListeners() {
    // Listen for backup mode changes
    this.registerCapabilityListener('backup_mode', this.onCapabilityBackupMode.bind(this));
    // Listen for force charge mode changes
    this.registerCapabilityListener('force_charge_mode', this.onCapabilityChargeMode.bind(this));
    // Listen for user work mode changes
    this.registerCapabilityListener('user_work_mode', this.onCapabilityUserWorkMode.bind(this));
    // Listen for force charge power changes
    this.registerCapabilityListener('force_charge_power', this.onCapabilityForceChargePower.bind(this));
    // Listen for force discharge power changes
    this.registerCapabilityListener('force_discharge_power', this.onCapabilityForceDisChargePower.bind(this));
    // Master on/off switch
    this.registerCapabilityListener('onoff', this.onCapabilityOnoff.bind(this));
    // Listen for force charge target changes
    this.registerCapabilityListener('force_charge_target', this.onCapabilityForceChargeTarget.bind(this));
    // Homey energy-management capabilities (target_power + mode are atomic)
    this.registerMultipleCapabilityListener(
      ['target_power', 'target_power_mode'],
      async (values) => {
        if (values.target_power_mode !== undefined) {
          await this.onCapabilityTargetPowerMode(values.target_power_mode);
        }
        if (values.target_power !== undefined) {
          await this.onCapabilityTargetPower(values.target_power);
        }
      },
      500
    );
    // Listen for operation mode changes (read-only, triggered from data updates)
    this.registerCapabilityListener('operation_mode', async (value, opts) => {
      this.log(`Operation mode changed to: ${value}`);
      
      if (this.operationModeChangedTrigger && !opts.fromCloudSync) {
        await this.operationModeChangedTrigger.trigger(this, 
          { mode: value }, 
          { mode: value }
        );
      }
    });
    this.log('Capability listeners registered');
  }
}

module.exports = VenusBatteryDevice;