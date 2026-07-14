const fs = require('fs');
const path = require('path');

class Logger {
  constructor() {
    this.logsDir = path.join(__dirname, 'logs');
    if (!fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true });
    }
  }

  _getLogFileName() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return path.join(this.logsDir, `${year}-${month}-${day}.log`);
  }

  _formatMessage(level, message) {
    const timestamp = new Date().toISOString();
    return `[${timestamp}] [${level}] ${message}`;
  }

  _write(level, message) {
    const formatted = this._formatMessage(level, message);
    
    // Stream to stdout for Docker logs
    console.log(formatted);

    // Write to daily log file
    try {
      fs.appendFileSync(this._getLogFileName(), formatted + '\n');
    } catch (err) {
      console.error(`Failed to write to log file: ${err.message}`);
    }
  }

  info(msg) { this._write('INFO', msg); }
  warn(msg) { this._write('WARN', msg); }
  error(msg, err) {
    const message = err ? `${msg} | Error: ${err.stack || err}` : msg;
    this._write('ERROR', message);
  }
}

module.exports = new Logger();
