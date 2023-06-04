const arrayRemove = require('unordered-array-remove')
const defaultGateway = require('default-gateway')
const debug = require('debug')('nat-api')
const NatUPNP = require('./lib/upnp')
const NatPMP = require('./lib/pmp')

class NatAPI {
  /**
  * opts:
  *  - ttl
  *  - description
  *  - gateway
  *  - autoUpdate
  *  - enablePMP (default = false)
  **/
  constructor (opts = {}) {
    // TTL is 2 hours (min 20 min)
    this.ttl = (opts.ttl) ? Math.max(opts.ttl, 1200) : 7200
    this.description = opts.description || 'NatAPI'
    this.gateway = opts.gateway || null
    this.autoUpdate = !!opts.autoUpdate || true

    // Refresh the mapping 10 minutes before the end of its lifetime
    this._timeout = (this.ttl - 600) * 1000
    this._destroyed = false
    this._openPorts = []
    this._upnpIntervals = {}
    this._pmpIntervals = {}

    // Setup UPnP Client
    this._upnpClient = NatUPNP.createClient()

    // Setup NAT-PMP Client
    this.enablePMP = !!opts.enablePMP
    if (this.enablePMP) {
      try {
        // Lookup gateway IP
        const results = defaultGateway.v4.sync()
        this._pmpClient = NatPMP.connect(results.gateway)
      } catch (err) {
        debug('Could not find gateway IP for NAT-PMP', err)
        this._pmpClient = null
      }
    } else {
      // Not necessary - but good for readability
      this._pmpClient = null
    }
  }

  /**
  * opts:
  *  - publicPort
  *  - privatePort
  *  - protocol
  *  - description
  *  - ttl
  *  - gateway
  **/
  async map (publicPort, privatePort) {
    if (this._destroyed) throw new Error('client is destroyed')

    // Validate input
    const { opts } = this._validateInput(publicPort, privatePort)

    if (opts.protocol) {
      // UDP or TCP
      await this._map(opts)
      const newOpts = Object.assign({}, opts)
      this._openPorts.push(newOpts)
    } else {
      // UDP & TCP

      // Map UDP
      const newOptsUDP = Object.assign({}, opts)
      newOptsUDP.protocol = 'UDP'
      await this._map(newOptsUDP)
      this._openPorts.push(newOptsUDP)

      // Map TCP
      const newOptsTCP = Object.assign({}, opts)
      newOptsTCP.protocol = 'TCP'
      await this._map(newOptsTCP)
      this._openPorts.push(newOptsTCP)
    }
  }

  /**
  * opts:
  *  - publicPort
  *  - privatePort
  *  - protocol
  *  - description
  *  - ttl
  *  - gateway
  **/
  async unmap (publicPort, privatePort) {
    if (this._destroyed) throw new Error('client is destroyed')

    // Validate input
    const { opts } = this._validateInput(publicPort, privatePort)

    arrayRemove(this._openPorts, this._openPorts.findIndex((o) => {
      return (o.publicPort === opts.publicPort) &&
        (o.privatePort === opts.privatePort) &&
        (o.protocol === opts.protocol || opts.protocol == null)
    }))

    if (opts.protocol) {
      // UDP or TCP
      await this._unmap(opts)
    } else {
      // UDP & TCP
      const newOptsUDP = Object.assign({}, opts)
      newOptsUDP.protocol = 'UDP'
      await this._unmap(newOptsUDP)
      const newOptsTCP = Object.assign({}, opts)
      newOptsTCP.protocol = 'TCP'
      await this._unmap(newOptsTCP)
    }
  }

  async destroy () {
    if (this._destroyed) throw new Error('client already destroyed')

    const continueDestroy = async () => {
      this._destroyed = true

      // Close NAT-PMP client
      if (this._pmpClient) {
        debug('Close PMP client')
        await this._pmpClient.close()
      }

      // Close UPNP Client
      if (this._upnpClient) {
        debug('Close UPnP client')
        await this._upnpClient.destroy()
      }
    }

    // Unmap all ports
    const openPortsCopy = Object.assign([], this._openPorts)

    for (const openPort of openPortsCopy) {
      await this.unmap(openPort)
    }

    await continueDestroy()
  }

  _validateInput (publicPort, privatePort) {
    let opts
    // opts
    opts = publicPort
    if (typeof publicPort === 'object') {
      // object
      opts = publicPort
    } else if (typeof publicPort === 'number' && typeof privatePort === 'number') {
      // number, number
      opts = {}
      opts.publicPort = publicPort
      opts.privatePort = privatePort
    } else if (typeof publicPort === 'number') {
      // number
      opts = {}
      opts.publicPort = publicPort
      opts.privatePort = publicPort
    } else {
      throw new Error('port was not specified')
    }

    if (opts.protocol && (typeof opts.protocol !== 'string' || !['UDP', 'TCP'].includes(opts.protocol.toUpperCase()))) {
      throw new Error('protocol is invalid')
    } else {
      opts.protocol = opts.protocol || null
    }
    opts.description = opts.description || this.description
    opts.ttl = opts.ttl || this.ttl
    opts.gateway = opts.gateway || this.gateway

    return { opts }
  }

  async _map (opts) {
    const tryUPNP = async () => {
      try {
        await this._upnpMap(opts)
      } catch (e) {
        throw new Error('NAT-PMP and UPnP port mapping failed')
      }
    }

    // Try NAT-PMP
    if (this._pmpClient) {
      try {
        await this._pmpMap(opts)
      } catch (e) {
        if (this._destroyed) return
        return await tryUPNP()
      }
    } else {
      // Try UPnP
      return await tryUPNP()
    }
  }

  async externalIp () {
    const tryUPNP = async () => {
      const ip = await this._upnpClient.externalIp()
      if (!ip) throw new Error('NAT-PMP and UPnP get external ip failed')
      return ip
    }

    let ip

    // Try NAT-PMP
    if (this._pmpClient) {
      try {
        ip = await this._pmpClient.externalIp()
      } catch (e) {}

      if (ip) return ip
      if (this._destroyed) return

      // NAT-PMP failed, trying Upnp
      try {
        return await tryUPNP()
      } catch (e) {
        throw new Error('NAT-PMP and UPnP get external ip failed')
      }
    } else {
      // Try UPnP
      return await tryUPNP()
    }
  }

  async _unmap (opts) {
    const tryUPNP = async () => {
      try {
        await this._upnpUnmap(opts)
      } catch (e) {
        if (this._pmpClient) throw new Error('NAT-PMP and UPnP port unmapping failed')
        else throw e
      }
    }

    // Try NAT-PMP
    if (this._pmpClient) {
      try {
        await this._pmpUnmap(opts)
      } catch (e) {
        return await tryUPNP()
      }
    } else {
      // Try UPnP
      await tryUPNP()
    }
  }

  async _upnpMap (opts) {
    debug('Mapping public port %d to private port %d by %s using UPnP', opts.publicPort, opts.privatePort, opts.protocol)

    await this._upnpClient.portMapping({
      public: opts.publicPort,
      private: opts.privatePort,
      description: opts.description,
      protocol: opts.protocol,
      ttl: opts.ttl
    })

    if (this.autoUpdate) {
      this._upnpIntervals[opts.publicPort + ':' + opts.privatePort + '-' + opts.protocol] = setInterval(
        this._upnpMap.bind(this, opts, () => {}),
        this._timeout
      )
    }

    debug('Port %d:%d for protocol %s mapped on router using UPnP', opts.publicPort, opts.privatePort, opts.protocol)
  }

  async _pmpMap (opts) {
    debug('Mapping public port %d to private port %d by %s using NAT-PMP', opts.publicPort, opts.privatePort, opts.protocol)

    // If we come from a timeouted (or error) request, we need to reconnect
    if (this._pmpClient && this._pmpClient.socket == null) {
      this._pmpClient = NatPMP.connect(this._pmpClient.gateway)
    }

    let timeouted = false
    const pmpTimeout = setTimeout(() => {
      timeouted = true
      this._pmpClient.close()
      const err = new Error('timeout')
      debug('Error mapping port %d:%d using NAT-PMP:', opts.publicPort, opts.privatePort, err.message)
      throw err
    }, 1000)

    await this._pmpClient.portMapping({
      public: opts.publicPort,
      private: opts.privatePort,
      type: opts.protocol,
      ttl: opts.ttl
    })

    if (timeouted) return
    clearTimeout(pmpTimeout)

    // Always close socket
    this._pmpClient.close()

    if (this.autoUpdate) {
      this._pmpIntervals[opts.publicPort + ':' + opts.privatePort + '-' + opts.protocol] = setInterval(
        this._pmpMap.bind(this, opts, () => {}),
        this._timeout
      )
    }

    debug('Port %d:%d for protocol %s mapped on router using NAT-PMP', opts.publicPort, opts.privatePort, opts.protocol)
  }

  async _upnpUnmap (opts) {
    debug('Unmapping public port %d to private port %d by %s using UPnP', opts.publicPort, opts.privatePort, opts.protocol)

    await this._upnpClient.portUnmapping({
      public: opts.publicPort,
      private: opts.privatePort,
      protocol: opts.protocol
    })

    // Clear intervals
    const key = opts.publicPort + ':' + opts.privatePort + '-' + opts.protocol
    if (this._upnpIntervals[key]) {
      clearInterval(this._upnpIntervals[key])
      delete this._upnpIntervals[key]
    }

    debug('Port %d:%d for protocol %s unmapped on router using UPnP', opts.publicPort, opts.privatePort, opts.protocol)
  }

  async _pmpUnmap (opts) {
    debug('Unmapping public port %d to private port %d by %s using NAT-PMP', opts.publicPort, opts.privatePort, opts.protocol)

    // If we come from a timeouted (or error) request, we need to reconnect
    if (this._pmpClient && this._pmpClient.socket == null) {
      this._pmpClient = NatPMP.connect(this._pmpClient.gateway)
    }

    let timeouted = false
    const pmpTimeout = setTimeout(() => {
      timeouted = true
      this._pmpClient.close()
      const err = new Error('timeout')
      debug('Error unmapping port %d:%d using NAT-PMP:', opts.publicPort, opts.privatePort, err.message)
      throw err
    }, 1000)

    try {
      await this._pmpClient.portUnmapping({
        public: opts.publicPort,
        private: opts.privatePort,
        type: opts.protocol
      })
    } catch (err) {
      if (timeouted) return
      clearTimeout(pmpTimeout)
      this._pmpClient.close()
      debug('Error unmapping port %d:%d using NAT-PMP:', opts.publicPort, opts.privatePort, err.message)
      throw err
    }

    if (timeouted) return
    clearTimeout(pmpTimeout)

    // Always close socket
    this._pmpClient.close()

    // Clear intervals
    const key = opts.publicPort + ':' + opts.privatePort + '-' + opts.protocol
    if (this._pmpIntervals[key]) {
      clearInterval(this._pmpIntervals[key])
      delete this._pmpIntervals[key]
    }

    debug('Port %d:%d for protocol %s unmapped on router using NAT-PMP', opts.publicPort, opts.privatePort, opts.protocol)
  }

  _checkPort (publicPort, cb) {
    // TOOD: check port
  }
}

module.exports = NatAPI
