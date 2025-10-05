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
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 5000; // Start with 5 seconds
    this.maxReconnectDelay = 60000; // Max 60 seconds
    this.isReconnecting = false;
  }

  async connect(config) {
    this.config = config;

    try {
      // Close existing connection if any
      if (this.connection) {
        try {
          if (this.socket && !this.socket.destroyed) {
            this.socket.end();
          }
        } catch (err) {
          console.log('Error closing existing connection:', err.message);
        }
        this.connection = null;
        this.socket = null;
      }

      console.dir(config);
      // Create new connection
      this.connection = await new Promise((resolve, reject) => {
        const connectTimeout = setTimeout(() => {
          reject(new Error('Connection timeout'));
        }, this.connectionTimeout);

        modbus.tcp.connect(config.port || 502, config.ip, { debug: null }, (err, connection) => {
          clearTimeout(connectTimeout);
          if (err) return reject(err);
          resolve(connection);
        });
      });

      //When we make it passed the connect without error
      this.connected = true;
      this.reconnectAttempts = 0; // Reset on successful connection
      this.isReconnecting = false;
      this.emit('connect');

      // Set timeout on the underlying socket
      this.socket = this.connection?.transport?.stream;
      if (this.socket) {
        this.socket.setTimeout(this.connectionTimeout);
      }

      // Setup event handlers
      this.setupConnectionHandlers();

      // You can now use this.connection to read/write
      return true;
    } catch (error) {
      this.connected = false;
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
      console.log('Connection error:', error.message);
      this.connected = false;
      this.emit('error', error);

      // Handle buffer/transport errors by reconnecting
      if (error.code === 'ERR_BUFFER_OUT_OF_BOUNDS' ||
          error.message.includes('buffer') ||
          error.message.includes('Transport')) {
        console.log('Buffer/transport error detected, forcing reconnection');
        this.forceReconnect();
      } else {
        this.scheduleReconnect();
      }
    });

    this.connection.on('close', () => {
      this.connected = false;
      this.emit('close');
      this.scheduleReconnect();
    });

    this.connection.on('timeout', () => {
      console.log('Socket timeout detected');
      // Don't immediately reconnect on timeout, just log it
      // Let the read/write operations handle their own timeouts
    });

    // Listen for errors on the underlying socket/transport
    try {
      if (this.socket) {
        this.socket.on('error', (error) => {
          console.log('Socket error:', error.message);
          // Socket errors often indicate connection issues
          this.connected = false;
          this.emit('error', error);
        });
      }

      // Listen for transport errors on the connection's transport layer
      if (this.connection.transport) {
        this.connection.transport.on('error', (error) => {
          console.log('Transport layer error:', error.message);
          // Transport errors indicate malformed packets - need to reconnect
          this.connected = false;
          this.forceReconnect();
        });
      }
    } catch (err) {
      console.log('Error setting up socket/transport handlers:', err.message);
    }
  }

  scheduleReconnect() {
    if (this.reconnectInterval || this.isReconnecting) {
      console.log('Reconnect already scheduled or in progress');
      return;
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log('Max reconnection attempts reached. Giving up.');
      this.emit('error', new Error('Max reconnection attempts reached'));
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;

    // Exponential backoff: delay * 2^(attempts-1), capped at maxReconnectDelay
    const delay = Math.min(
      this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
      this.maxReconnectDelay
    );

    console.log(`Scheduling reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`);

    this.reconnectInterval = setTimeout(async () => {
      this.reconnectInterval = null;
      if (this.config) {
        console.log(`Attempting reconnection (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
        const success = await this.connect(this.config);
        if (!success) {
          this.isReconnecting = false;
          this.scheduleReconnect(); // Try again with exponential backoff
        }
      } else {
        this.isReconnecting = false;
      }
    }, delay);
  }

  clearReconnectInterval() {
    if (this.reconnectInterval) {
      clearTimeout(this.reconnectInterval);
      this.reconnectInterval = null;
    }
  }

  forceReconnect() {
    console.log('Forcing immediate reconnection due to transport error');

    // Clear any pending reconnection
    this.clearReconnectInterval();
    this.isReconnecting = false;

    // Close current connection
    try {
      if (this.socket && !this.socket.destroyed) {
        this.socket.destroy(); // Destroy instead of end() for immediate close
      }
    } catch (err) {
      console.log('Error destroying socket:', err.message);
    }

    this.connection = null;
    this.socket = null;
    this.connected = false;

    // Schedule immediate reconnection (small delay to allow cleanup)
    setTimeout(() => {
      if (this.config) {
        this.connect(this.config);
      }
    }, 1000);
  }

  async readHoldingRegisters(slaveId, address, quantity, retries = 2) {
    if (!this.connected || !this.connection) {
      throw new Error('Modbus not connected');
    }

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const result = await new Promise((resolve, reject) => {
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

        return result; // Success, return the data
      } catch (err) {
        // Check for buffer/transport errors
        if (err.code === 'ERR_BUFFER_OUT_OF_BOUNDS' ||
            err.message.includes('buffer bounds')) {
          console.log('Buffer error during read, forcing reconnection');
          this.forceReconnect();
          throw new Error('Transport error - reconnecting');
        }

        if (attempt < retries) {
          console.log(`Read failed (attempt ${attempt + 1}/${retries + 1}), retrying...`, err.message);

          // Check if still connected, if not don't retry
          if (!this.connected || !this.connection) {
            throw new Error('Connection lost during retry');
          }

          await new Promise(resolve => setTimeout(resolve, 500)); // Wait 500ms before retry
        } else {
          throw err; // Final attempt failed, throw error
        }
      }
    }
  }

  async writeSingleRegister(slaveId, address, value, retries = 2) {
    if (!this.connected || !this.connection) {
      throw new Error('Modbus not connected');
    }

    // Convert number to Buffer (16-bit big-endian format)
    const bufferValue = Buffer.allocUnsafe(2);
    bufferValue.writeUInt16BE(value, 0);

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const result = await new Promise((resolve, reject) => {
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

        return result; // Success
      } catch (err) {
        // Check for buffer/transport errors
        if (err.code === 'ERR_BUFFER_OUT_OF_BOUNDS' ||
            err.message.includes('buffer bounds')) {
          console.log('Buffer error during write, forcing reconnection');
          this.forceReconnect();
          throw new Error('Transport error - reconnecting');
        }

        if (attempt < retries) {
          console.log(`Write failed (attempt ${attempt + 1}/${retries + 1}), retrying...`, err.message);

          // Check if still connected, if not don't retry
          if (!this.connected || !this.connection) {
            throw new Error('Connection lost during retry');
          }

          await new Promise(resolve => setTimeout(resolve, 500)); // Wait 500ms before retry
        } else {
          throw err; // Final attempt failed, throw error
        }
      }
    }
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

  /**
   * Modbus String Conversion Utilities
   * Converts Modbus register responses to strings for text data
   */

  /**
   * Convert buffer to string (for text data from Modbus)
   * @param {Buffer|Array} buffer - Buffer from Modbus response
   * @param {object} options - String conversion options
   * @returns {string} Converted string
   */
  static bufferToString(buffer, options = {}) {
    const {
      encoding = 'ascii',     // 'ascii', 'utf8', 'latin1'
      trimNull = true,        // Remove null terminators
      trimWhitespace = true,  // Trim leading/trailing whitespace
      swapBytes = false       // Swap byte order within each register
    } = options;
    
    // Handle case where buffer is wrapped in an array
    if (Array.isArray(buffer) && buffer.length > 0 && Buffer.isBuffer(buffer[0])) {
      buffer = buffer[0];
    }
    
    if (!Buffer.isBuffer(buffer)) {
      throw new Error('Invalid buffer for string conversion');
    }
    
    let workingBuffer = buffer;
    
    // Swap bytes within each 16-bit register if needed
    if (swapBytes && buffer.length >= 2) {
      workingBuffer = Buffer.alloc(buffer.length);
      for (let i = 0; i < buffer.length; i += 2) {
        if (i + 1 < buffer.length) {
          workingBuffer[i] = buffer[i + 1];
          workingBuffer[i + 1] = buffer[i];
        } else {
          workingBuffer[i] = buffer[i];
        }
      }
    }
    
    // Convert to string
    let result = workingBuffer.toString(encoding);
    
    // Remove null terminators
    if (trimNull) {
      const nullIndex = result.indexOf('\0');
      if (nullIndex !== -1) {
        result = result.substring(0, nullIndex);
      }
    }
    
    // Trim whitespace
    if (trimWhitespace) {
      result = result.trim();
    }
    
    return result;
  }

  /**
   * Convert string buffer with automatic encoding detection
   * @param {Buffer|Array} buffer - Buffer from Modbus response
   * @param {object} options - Conversion options
   * @returns {object} Object with string and detected info
   */
  static bufferToStringAuto(buffer, options = {}) {
    const { trimNull = true, trimWhitespace = true, swapBytes = false } = options;
    
    const encodings = ['ascii', 'utf8', 'latin1'];
    const results = [];
    
    for (const encoding of encodings) {
      try {
        const str = bufferToString(buffer, { 
          encoding, 
          trimNull, 
          trimWhitespace, 
          swapBytes 
        });
        
        // Check if string contains mostly printable characters
        const printableRatio = str.split('').filter(c => {
          const code = c.charCodeAt(0);
          return code >= 32 && code <= 126; // Printable ASCII range
        }).length / str.length;
        
        results.push({
          encoding,
          string: str,
          printableRatio,
          length: str.length
        });
      } catch (error) {
        // Skip encoding if it fails
      }
    }
    
    // Return the encoding with the highest printable character ratio
    const best = results.sort((a, b) => b.printableRatio - a.printableRatio)[0];
    
    return {
      string: best ? best.string : '',
      encoding: best ? best.encoding : 'ascii',
      printableRatio: best ? best.printableRatio : 0,
      allResults: results
    };
  }

  /**
   * Helper function to calculate required number of registers for string length
   * @param {number} stringLength - Length of string in bytes
   * @returns {number} Number of Modbus registers needed
   */
  static calculateRegistersForString(stringLength) {
    return Math.ceil(stringLength / 2);
  }

  /**
   * Comprehensive string extraction from Modbus with error handling
   * @param {Buffer|Array} modbusResponse - Response from Modbus read
   * @param {object} options - Configuration options
   * @returns {object} String extraction result
   */
  static extractStringFromModbus(modbusResponse, options = {}) {
    const {
      encoding = 'ascii',
      trimNull = true,
      trimWhitespace = true,
      swapBytes = false,
      maxLength = null,
      autoDetectEncoding = false
    } = options;
    
    try {
      let result;
      
      if (autoDetectEncoding) {
        result = bufferToStringAuto(modbusResponse, {
          trimNull,
          trimWhitespace,
          swapBytes
        });
        
        return {
          success: true,
          string: result.string,
          encoding: result.encoding,
          length: result.string.length,
          printableRatio: result.printableRatio,
          truncated: false
        };
      } else {
        let extractedString = bufferToString(modbusResponse, {
          encoding,
          trimNull,
          trimWhitespace,
          swapBytes
        });
        
        let truncated = false;
        if (maxLength && extractedString.length > maxLength) {
          extractedString = extractedString.substring(0, maxLength);
          truncated = true;
        }
        
        return {
          success: true,
          string: extractedString,
          encoding: encoding,
          length: extractedString.length,
          truncated: truncated
        };
      }
      
    } catch (error) {
      return {
        success: false,
        string: '',
        encoding: null,
        length: 0,
        error: error.message,
        truncated: false
      };
    }
  }

  /**
   * Debug function to inspect buffer contents
   * @param {Buffer|Array} buffer - Buffer to inspect
   * @returns {object} Debug information
   */
  static debugBuffer(buffer) {
    // Handle case where buffer is wrapped in an array
    if (Array.isArray(buffer) && buffer.length > 0 && Buffer.isBuffer(buffer[0])) {
      buffer = buffer[0];
    }
    
    if (!Buffer.isBuffer(buffer)) {
      return { error: 'Not a valid buffer' };
    }
    
    const bytes = Array.from(buffer);
    const hex = buffer.toString('hex');
    const ascii = buffer.toString('ascii').replace(/[\x00-\x1F\x7F-\xFF]/g, '.');
    
    return {
      length: buffer.length,
      bytes: bytes,
      hex: hex,
      ascii: ascii,
      registers: Math.ceil(buffer.length / 2),
      hasNullBytes: bytes.includes(0),
      printableChars: ascii.replace(/\./g, '').length
    };
  }

  static stringToModbusBuffer(str, maxLength, options = {}) {
    const {
      encoding = 'ascii',
      padWithNull = true,
      swapBytes = false
    } = options;
    
    // Truncate string if too long
    let workingString = str;
    if (workingString.length > maxLength) {
      workingString = workingString.substring(0, maxLength);
    }
    
    // Create buffer from string
    let buffer = Buffer.from(workingString, encoding);
    
    // Pad with null bytes if shorter than maxLength
    if (padWithNull && buffer.length < maxLength) {
      const paddedBuffer = Buffer.alloc(maxLength);
      buffer.copy(paddedBuffer);
      // Rest of buffer is already filled with zeros
      buffer = paddedBuffer;
    }
    
    // Swap bytes within each register if needed
    if (swapBytes && buffer.length >= 2) {
      const swappedBuffer = Buffer.alloc(buffer.length);
      for (let i = 0; i < buffer.length; i += 2) {
        if (i + 1 < buffer.length) {
          swappedBuffer[i] = buffer[i + 1];
          swappedBuffer[i + 1] = buffer[i];
        } else {
          swappedBuffer[i] = buffer[i];
        }
      }
      buffer = swappedBuffer;
    }
    
    return buffer;
  }

  /**
   * Convert buffer to array of 16-bit register values for Modbus writing
   * @param {Buffer} buffer - Buffer to convert
   * @param {boolean} littleEndian - Byte order (default: false for big-endian)
   * @returns {Array<number>} Array of register values
   */
  static bufferToRegisters(buffer, littleEndian = false) {
    const registers = [];
    
    for (let i = 0; i < buffer.length; i += 2) {
      let registerValue;
      if (i + 1 < buffer.length) {
        // Two bytes available
        registerValue = littleEndian ? 
          buffer.readUInt16LE(i) : 
          buffer.readUInt16BE(i);
      } else {
        // Only one byte available, pad with zero
        registerValue = littleEndian ? 
          buffer[i] : 
          (buffer[i] << 8);
      }
      registers.push(registerValue);
    }
    
    return registers;
  }
}

module.exports = ModbusClient;