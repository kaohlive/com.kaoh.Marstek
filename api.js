'use strict';

module.exports = {
  /**
   * GET /devices - Get all Venus devices
   */
  async getDevices({ homey }) {
    try {
      const devices = homey.app.getVenusDevices();
      return { devices };
    } catch (error) {
      homey.app.error('API getDevices error:', error);
      return { error: error.message };
    }
  },

  /**
   * POST /readRegister - Read a Modbus register
   * Body: { deviceId, address, count }
   */
  async readRegister({ homey, body }) {
    try {
      const { deviceId, address, count } = body;

      if (!deviceId || address === undefined) {
        return { success: false, error: 'Missing deviceId or address' };
      }

      const result = await homey.app.readRegister(deviceId, address, count || 1);
      return result;
    } catch (error) {
      homey.app.error('API readRegister error:', error);
      return { success: false, error: error.message };
    }
  },

  /**
   * POST /writeRegister - Write a value to a Modbus register
   * Body: { deviceId, address, value }
   */
  async writeRegister({ homey, body }) {
    try {
      const { deviceId, address, value } = body;

      if (!deviceId || address === undefined || value === undefined) {
        return { success: false, error: 'Missing deviceId, address, or value' };
      }

      const result = await homey.app.writeRegister(deviceId, address, value);
      return result;
    } catch (error) {
      homey.app.error('API writeRegister error:', error);
      return { success: false, error: error.message };
    }
  },

  /**
   * GET /modeEvents?deviceId=... - Diagnostic ringbuffer of work-mode events.
   * Used by the settings page to inspect write→stable-read latency.
   */
  async getModeEvents({ homey, query }) {
    try {
      const deviceId = query && query.deviceId;
      if (!deviceId) {
        return { success: false, error: 'Missing deviceId' };
      }
      const events = homey.app.getModeEvents(deviceId);
      return { success: true, events };
    } catch (error) {
      homey.app.error('API getModeEvents error:', error);
      return { success: false, error: error.message };
    }
  },

  /**
   * POST /clearModeEvents - Clear the diagnostic ringbuffer.
   * Body: { deviceId }
   */
  async clearModeEvents({ homey, body }) {
    try {
      const deviceId = body && body.deviceId;
      if (!deviceId) {
        return { success: false, error: 'Missing deviceId' };
      }
      return homey.app.clearModeEvents(deviceId);
    } catch (error) {
      homey.app.error('API clearModeEvents error:', error);
      return { success: false, error: error.message };
    }
  },

  /**
   * POST /pollState - Poll all known registers from a device
   * Body: { deviceId }
   */
  async pollState({ homey, body }) {
    try {
      const { deviceId } = body;

      if (!deviceId) {
        return { success: false, error: 'Missing deviceId' };
      }

      const result = await homey.app.pollDeviceState(deviceId);
      return result;
    } catch (error) {
      homey.app.error('API pollState error:', error);
      return { success: false, error: error.message };
    }
  }
};
