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
   * Called when the app is stopped, updated or reinstalled.
   *
   * Device.onUninit already does this per device, but Homey does not guarantee
   * it runs on every teardown path, and a missed close is expensive: a Venus V3
   * serves one Modbus TCP client at a time and keeps a stale slot occupied
   * until its firmware times it out, which testers experience as "no data for
   * hours after an app update". Releasing here as well is belt and braces, and
   * idempotent - the device guards against being released twice.
   */
  async onUninit() {
    this.log('App shutting down - releasing Modbus connections');

    const releases = [];
    for (const id of ['venus', 'venusd']) {
      let driver;
      try {
        driver = this.homey.drivers.getDriver(id);
      } catch (err) {
        continue;
      }
      if (!driver) continue;
      for (const device of driver.getDevices()) {
        if (typeof device.onUninit !== 'function') continue;
        releases.push(Promise.resolve().then(() => device.onUninit()).catch(() => {}));
      }
    }

    // Bounded for the same reason as in the device: the FIN leaves the moment
    // close() is called, and Homey's shutdown window is short - blocking on it
    // only risks being killed mid-shutdown.
    await Promise.race([
      Promise.all(releases),
      new Promise((resolve) => setTimeout(resolve, 2500)),
    ]);

    this.log(`Released ${releases.length} Modbus connection(s)`);
  }

  /**
   * Get all Marstek battery devices across all drivers (venus + venusd).
   * Used by the settings page to list available devices.
   */
  getVenusDevices() {
    const driverIds = ['venus', 'venusd'];
    const out = [];
    for (const id of driverIds) {
      const driver = this.homey.drivers.getDriver(id);
      if (!driver) continue;
      for (const device of driver.getDevices()) {
        out.push({
          id: device.getData().id,
          name: device.getName(),
          driver: id,
          ip: device.getSetting('ip'),
          port: device.getSetting('port'),
          slaveId: device.getSetting('slave_id'),
        });
      }
    }
    return out;
  }

  /**
   * Diagnostic: return the mode-events ringbuffer for a device.
   * Only the venus driver implements this (write→stable-read latency tracking
   * for force-mode writes); the venusd driver does not.
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
   * Find a device by ID, searching both venus and venusd drivers.
   * Name retained for backwards-compat with existing settings-page code.
   */
  getVenusDeviceById(deviceId) {
    const driverIds = ['venus', 'venusd'];
    for (const id of driverIds) {
      const driver = this.homey.drivers.getDriver(id);
      if (!driver) continue;
      const device = driver.getDevices().find(d => d.getData().id === deviceId);
      if (device) return device;
    }
    return null;
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
