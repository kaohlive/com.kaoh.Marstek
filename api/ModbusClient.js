'use strict';

const modbus = require('modbus-stream');
const EventEmitter = require('events');

class ModbusClient extends EventEmitter {
  constructor() {
    super();
    this.connection = null;
    this.connected = false;
    this.connectionTimeout = 5000;
    this.reconnectInterval = null;
    this.config = null;
  }

  async connect(config) {
    this.config = config;
    
    try {
      // Close existing connection if any
      if (this.connection && !this.connection.destroyed) {
        this.socket.end();
      }
      console.dir(config);
      // Create new connection
      this.connection = await new Promise((resolve, reject) => {
        modbus.tcp.connect(config.port || 502, config.ip, { debug: null }, (err, connection) => {
          if (err) return reject(err);
          resolve(connection);
        });
      });
      //When we make it passed the connect without error 
      this.connected = true;
      this.emit('connect');
      // Set timeout on the underlying socket
      this.socket = this.connection?.transport?.stream;
      this.socket.setTimeout(this.connectionTimeout);

      // Setup event handlers
      this.setupConnectionHandlers();

      // You can now use this.connection to read/write
      return true;
    } catch (error) {
      this.emit('error', error);
      return false;
    }
  }

  setupConnectionHandlers() {
    console.log('Setup connection handling for the modbus connection');
    if (!this.connection) return;

    this.connection.on('connect', () => {
      this.connected = true;
      this.clearReconnectInterval();
      this.emit('connect');
    });

    this.connection.on('error', (error) => {
      this.connected = false;
      this.emit('error', error);
      this.scheduleReconnect();
    });

    this.connection.on('close', () => {
      this.connected = false;
      this.emit('close');
      this.scheduleReconnect();
    });

    this.connection.on('timeout', () => {
      this.connected = false;
      this.emit('error', new Error('Connection timeout'));
      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.reconnectInterval) return;
    
    this.reconnectInterval = setTimeout(async () => {
      this.reconnectInterval = null;
      if (this.config) {
        await this.connect(this.config);
      }
    }, 5000); // Reconnect after 5 seconds
  }

  clearReconnectInterval() {
    if (this.reconnectInterval) {
      clearTimeout(this.reconnectInterval);
      this.reconnectInterval = null;
    }
  }

  async readHoldingRegisters(slaveId, address, quantity) {
    if (!this.connected || !this.connection) {
      throw new Error('Modbus not connected');
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Read operation timeout'));
      }, this.connectionTimeout);

      this.connection.readHoldingRegisters({ 
        unitId: slaveId || 1,
        address, 
        quantity 
      }, (err, info) => {
        clearTimeout(timeout);
        
        if (err) {
          reject(err);
        } else {
          resolve(info.response.data);
        }
      });
    });
  }

  async writeSingleRegister(slaveId, address, value) {
    if (!this.connected || !this.connection) {
      throw new Error('Modbus not connected');
    }

    // Convert number to Buffer (16-bit big-endian format)
    const bufferValue = Buffer.allocUnsafe(2);
    bufferValue.writeUInt16BE(value, 0);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Write operation timeout'));
      }, this.connectionTimeout);

      this.connection.writeSingleRegister({ 
        unitId: slaveId || 1,
        address, 
        value: bufferValue 
      }, (err, info) => {
        clearTimeout(timeout);
        
        if (err) {
          reject(err);
        } else {
          resolve(info);
        }
      });
    });
  }

  async writeMultipleRegisters(slaveId, address, values) {
    if (!this.connected || !this.connection) {
      throw new Error('Modbus not connected');
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Write operation timeout'));
      }, this.connectionTimeout);

      this.connection.writeMultipleRegisters({ 
        unitId: slaveId || 1,
        address, 
        values 
      }, (err, info) => {
        clearTimeout(timeout);
        
        if (err) {
          reject(err);
        } else {
          resolve(info);
        }
      });
    });
  }

  isConnected() {
    return this.connected;
  }

  disconnect() {
    this.clearReconnectInterval();
    
    if (this.connection && !this.connection.destroyed) {
      this.socket.end();
    }
    
    this.connected = false;
    this.connection = null;
    this.config = null;
  }

  // Utility functions
  static signedInt16(value) {
    return value > 32767 ? value - 65536 : value;
  }

  static bufferToUint16(buffer, littleEndian = false) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 2) {
      throw new Error('Buffer must be at least 2 bytes for uint16');
    }
    return littleEndian ? buffer.readUInt16LE(0) : buffer.readUInt16BE(0);
  }

  static bufferToInt16(buffer, littleEndian = false) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 2) {
      throw new Error('Buffer must be at least 2 bytes for int16');
    }
    return littleEndian ? buffer.readInt16LE(0) : buffer.readInt16BE(0);
  }

  static bufferToInt32(buffer, littleEndian = false, swapWords = false) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
      throw new Error('Buffer must be at least 4 bytes for int32');
    }
    
    if (swapWords) {
      // Some devices store 32-bit values with swapped word order
      const word1 = littleEndian ? buffer.readUInt16LE(2) : buffer.readUInt16BE(2);
      const word2 = littleEndian ? buffer.readUInt16LE(0) : buffer.readUInt16BE(0);
      const value = (word1 << 16) | word2;
      return value | 0; // Convert to signed 32-bit
    } else {
      return littleEndian ? buffer.readInt32LE(0) : buffer.readInt32BE(0);
    }
  }

  static bufferToUint32(buffer, littleEndian = false, swapWords = false) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
      throw new Error('Buffer must be at least 4 bytes for uint32');
    }
    
    let value;
    if (swapWords) {
      // Some devices store 32-bit values with swapped word order
      const word1 = littleEndian ? buffer.readUInt16LE(2) : buffer.readUInt16BE(2);
      const word2 = littleEndian ? buffer.readUInt16LE(0) : buffer.readUInt16BE(0);
      value = (word1 << 16) | word2;
    } else {
      value = littleEndian ? buffer.readUInt32LE(0) : buffer.readUInt32BE(0);
    }
    
    return value >>> 0; // Ensure unsigned
  }

  static combineRegisters(high, low) {
    return (high << 16) + low;
  }

  static splitToRegisters(value32) {
    return {
      high: (value32 >> 16) & 0xFFFF,
      low: value32 & 0xFFFF
    };
  }
}

module.exports = ModbusClient;