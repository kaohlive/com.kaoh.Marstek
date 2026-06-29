'use strict';

const Homey = require('homey');
const ModbusClient = require('../../api/ModbusClient');

// Marstek Venus D driver (also marketed by some resellers as "Duravolt").
//
// Venus D is a PV-hybrid battery from a different Marstek product family
// than the Venus E series; it has its own Modbus register map (30xxx/34xxx/
// 37xxx ranges plus dedicated MPPT registers 30020-30040). The venus driver
// reads from 32xxx registers which mostly do not exist on Venus D - we
// keep these two drivers strictly separate to avoid the mis-detection
// problem field-reported on the v1.4.0 release.
//
// Pair-time guard: this driver rejects any device whose name register
// (31000) looks like a Venus E / V3 / V1-V2. The venus driver does the
// inverse: it rejects VNSD* names and tells the user to pair with this
// driver instead.

class VenusDDriver extends Homey.Driver {

  async onInit() {
    this.log('VenusDDriver has been initialized');
  }

  async onPair(session) {
    session.setHandler('test_connection', async (data) => {
      this.log(`Testing Venus D connection to ${data.ip}:${data.port} (slave ${data.slave_id})`);

      const client = new ModbusClient();
      try {
        const connected = await client.connect({ ip: data.ip, port: data.port });
        if (!connected) {
          return { success: false, message: 'Could not connect to device' };
        }

        // Read device name (register 31000, 10 registers / 20 bytes) so we can
        // verify this is actually a Venus D and not a Venus E that landed on
        // the wrong driver. The Modbus error here gives us the early signal.
        const reg_name = await client.readHoldingRegisters(data.slave_id, 31000, 10);
        const deviceName = ModbusClient.bufferToString(reg_name).trim();
        const lower = deviceName.toLowerCase();

        await client.disconnect();

        // Reject Venus E / V3 / V1-V2 hardware that should be on the venus
        // driver. We err on the permissive side for everything else: if the
        // user explicitly picked the Venus D driver, they probably know
        // what they have.
        if (lower.startsWith('vnse') || lower.startsWith('ac') || lower.startsWith('limited') || lower.includes('bi_')) {
          return {
            success: false,
            message: `This device identifies as "${deviceName}" which is a Venus E / V3 / V1-V2 - please pair it with the "Venus E" driver instead, not the Venus D driver.`,
          };
        }

        this.log(`Connection test successful: detected "${deviceName}"`);
        return { success: true, deviceName };
      } catch (err) {
        this.log('Connection test failed:', err.message);
        await client.disconnect().catch(() => {});
        return { success: false, message: err.message };
      }
    });
  }
}

module.exports = VenusDDriver;
