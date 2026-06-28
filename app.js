'use strict';

const Homey = require('homey');

module.exports = class MyMarstekBatteryApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('MyMarstekBatteryApp has been initialized');

    // Handle uncaught exceptions from the Modbus transport layer
    // These can occur when the device sends malformed/truncated responses
    process.on('uncaughtException', (error) => {
      if (error.code === 'ERR_BUFFER_OUT_OF_BOUNDS' ||
          error.name === 'RangeError' ||
          (error.message && error.message.includes('buffer'))) {
        this.log('Caught uncaught buffer exception from Modbus transport - this is expected when device sends malformed data');
        // Don't crash - the ModbusClient will handle reconnection
      } else {
        // Re-throw other uncaught exceptions
        this.error('Uncaught exception:', error);
        throw error;
      }
    });

    // NOTE: We deliberately do NOT instantiate a separate ModbusClient here
    // for diagnostic endpoints. Marstek hardware with native Modbus TCP only
    // accepts one client at a time; a second ModbusClient living on this app
    // would open a parallel TCP socket to the same device and compete with
    // the device's own poller for the single slot. All diagnostic endpoints
    // below delegate through the matching device's existing ModbusClient.
  }

  /**
   * Get all Venus battery devices
   * Used by the settings page to list available devices
   */
  getVenusDevices() {
    const driver = this.homey.drivers.getDriver('venus');
    if (!driver) {
      return [];
    }

    const devices = driver.getDevices();
    return devices.map(device => ({
      id: device.getData().id,
      name: device.getName(),
      ip: device.getSetting('ip'),
      port: device.getSetting('port'),
      slaveId: device.getSetting('slave_id')
    }));
  }

  /**
   * Diagnostic: return the mode-events ringbuffer for a device.
   * Used by the settings page to inspect write→stable-read latency.
   */
  getModeEvents(deviceId) {
    const device = this.getVenusDeviceById(deviceId);
    if (!device) {
      throw new Error('Device not found');
    }
    return typeof device.getModeEvents === 'function' ? device.getModeEvents() : [];
  }

  clearModeEvents(deviceId) {
    const device = this.getVenusDeviceById(deviceId);
    if (!device) {
      throw new Error('Device not found');
    }
    if (typeof device.clearModeEvents === 'function') {
      device.clearModeEvents();
    }
    return { success: true };
  }

  /**
   * Get a Venus device by its ID
   */
  getVenusDeviceById(deviceId) {
    const driver = this.homey.drivers.getDriver('venus');
    if (!driver) {
      return null;
    }

    const devices = driver.getDevices();
    return devices.find(device => device.getData().id === deviceId);
  }

  /**
   * Read a Modbus register from a device. Delegates through the device's own
   * ModbusClient so settings-page reads cannot collide with the slow poll
   * on the single Marstek native-Modbus client slot.
   */
  async readRegister(deviceId, address, count = 1) {
    const device = this.getVenusDeviceById(deviceId);
    if (!device) {
      throw new Error('Device not found');
    }
    try {
      return await device.apiReadRegister(address, count);
    } catch (error) {
      this.error('Error reading register:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Write a value to a Modbus register. Delegates through the device's own
   * ModbusClient (see readRegister for why).
   */
  async writeRegister(deviceId, address, value) {
    const device = this.getVenusDeviceById(deviceId);
    if (!device) {
      throw new Error('Device not found');
    }
    try {
      return await device.apiWriteRegister(address, value);
    } catch (error) {
      this.error('Error writing register:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Poll all known registers from a device for the settings-page "Device
   * state dump" button. Delegates through the device's own ModbusClient.
   */
  async pollDeviceState(deviceId) {
    const device = this.getVenusDeviceById(deviceId);
    if (!device) {
      throw new Error('Device not found');
    }
    try {
      return await device.apiPollState();
    } catch (error) {
      this.error('Error polling device state:', error);
      return { success: false, error: error.message };
    }
  }
};
