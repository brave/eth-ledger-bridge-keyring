const TransportWebHID = require('@ledgerhq/hw-transport-webhid').default
const LedgerEth = require('@ledgerhq/hw-app-eth').default
const WebSocketTransport = require('@ledgerhq/hw-transport-http/lib/WebSocketTransport').default

'use strict'
require('buffer')

// URL which triggers Ledger Live app to open and handle communication
const BRIDGE_URL = 'ws://localhost:8435'

// Number of seconds to poll for Ledger Live and Ethereum app opening
const TRANSPORT_CHECK_DELAY = 1000
const TRANSPORT_CHECK_LIMIT = 120

module.exports = class LedgerBridge {
  constructor () {
    this.useLedgerLive = false
  }

  request (data, cb) {
    const { action, params } = data
    switch (action) {
      case 'ledger-unlock':
        this.unlock(cb, params.hdPath)
        break
      case 'ledger-sign-transaction':
        this.signTransaction(cb, params.hdPath, params.tx)
        break
      case 'ledger-sign-personal-message':
        this.signPersonalMessage(cb, params.hdPath, params.message)
        break
      case 'ledger-close-bridge':
        this.cleanUp(cb)
        break
      case 'ledger-update-transport':
        this.updateLedgerLivePreference(cb, params.useLedgerLive)
        break
      case 'ledger-sign-typed-data':
        this.signTypedData(cb, params.hdPath, params.domainSeparatorHex, params.hashStructMessageHex)
        break
      default:
        break
    }
  }

  delay (ms) {
    return new Promise((success) => setTimeout(success, ms))
  }

  checkTransportLoop (i) {
    const iterator = i || 0
    return WebSocketTransport.check(BRIDGE_URL).catch(async () => {
      await this.delay(TRANSPORT_CHECK_DELAY)
      if (iterator < TRANSPORT_CHECK_LIMIT) {
        return this.checkTransportLoop(iterator + 1)
      }
      throw new Error('Ledger transport check timeout')

    })
  }

  async makeApp () {
    try {
      if (this.useLedgerLive) {
        let reestablish = false
        try {
          await WebSocketTransport.check(BRIDGE_URL)
        } catch (_err) {
          window.open('ledgerlive://bridge?appName=Ethereum')
          await this.checkTransportLoop()
          reestablish = true
        }
        if (!this.app || reestablish) {
          this.transport = await WebSocketTransport.open(BRIDGE_URL)
          this.app = new LedgerEth(this.transport)
        }
      } else {
        window.TransportWebHID = TransportWebHID
        window.LedgerEth = LedgerEth
        this.transport = await TransportWebHID.create()
        this.app = new LedgerEth(this.transport)
      }
    } catch (e) {
      console.log('LEDGER:::CREATE APP ERROR', e)
      throw e
    }
  }

  updateLedgerLivePreference (cb, useLedgerLive) {
    this.useLedgerLive = useLedgerLive
    this.cleanUp()
    cb(true)
  }

  cleanUp (cb) {
    this.app = null
    if (this.transport) {
      this.transport.close()
    }
    if (cb) {
      cb(true)
    }
  }

  async unlock (cb, hdPath) {
    try {
      await this.makeApp()
      const res = await this.app.getAddress(hdPath, false, true)
      cb(true, res)
    } catch (err) {
      const e = this.ledgerErrToMessage(err)
      cb(false, { error: e.toString() })
    } finally {
      if (!this.useLedgerLive) {
        this.cleanUp()
      }
    }
  }

  async signTransaction (cb, hdPath, tx) {
    try {
      await this.makeApp()
      const res = await this.app.signTransaction(hdPath, tx)
      cb(true, res)
    } catch (err) {
      const e = this.ledgerErrToMessage(err)
      cb(false, { error: e.toString() })
    } finally {
      if (!this.useLedgerLive) {
        this.cleanUp()
      }
    }
  }

  async signPersonalMessage (cb, hdPath, message) {
    try {
      await this.makeApp()

      const res = await this.app.signPersonalMessage(hdPath, message)
      cb(true, res)
    } catch (err) {
      const e = this.ledgerErrToMessage(err)
      cb(false, { error: e.toString() })
    } finally {
      if (!this.useLedgerLive) {
        this.cleanUp()
      }
    }
  }

  async signTypedData (cb, hdPath, domainSeparatorHex, hashStructMessageHex) {
    try {
      await this.makeApp()
      const res = await this.app.signEIP712HashedMessage(hdPath, domainSeparatorHex, hashStructMessageHex)
      cb(true, res)
    } catch (err) {
      const e = this.ledgerErrToMessage(err)
      cb(false, { error: e.toString() })
    } finally {
      this.cleanUp()
    }
  }

  ledgerErrToMessage (err) {
    const isU2FError = (err) => Boolean(err) && Boolean((err).metaData)
    const isStringError = (err) => typeof err === 'string'
    const isErrorWithId = (err) => err.hasOwnProperty('id') && err.hasOwnProperty('message')
    const isWrongAppError = (err) => String(err.message || err).includes('6804')
    const isLedgerLockedError = (err) => err.message && err.message.includes('OpenFailed')

    // https://developers.yubico.com/U2F/Libraries/Client_error_codes.html
    if (isU2FError(err)) {
      if (err.metaData.code === 5) {
        return 'LEDGER_TIMEOUT'
      }
      return err.metaData.type
    }

    if (isWrongAppError(err)) {
      return 'LEDGER_WRONG_APP'
    }

    if (isLedgerLockedError(err) || (isStringError(err) && err.includes('6801'))) {
      return 'LEDGER_LOCKED'
    }

    if (isErrorWithId(err)) {
      // Browser doesn't support U2F
      if (err.message.includes('U2F not supported')) {
        return 'U2F_NOT_SUPPORTED'
      }
    }

    // Other
    return err.toString()
  }
}
