import arrayRemove from 'unordered-array-remove'
import { gateway4sync as v4 } from 'default-gateway'
import Debug from 'debug'
import NatUPNP from './lib/upnp/index.js'
import NatPMP from './lib/pmp/index.js'

const debug = Debug('nat-api')

export default class NatAPI {
  /**
  * opts:
  *  - ttl
  *  - description
  *  - gateway
  *  - autoUpdate
  *  - enablePMP (default = false)
  *  - enableUPNP (default = false)
  *  - upnpPermanentFallback (default = false)
  **/
  constructor (opts = {}) {
    // TTL is 2 hours (min 20 min)
    this.ttl = (opts.ttl) ? Math.max(opts.ttl, 1200) : 7200
    this.description = opts.description || 'NatAPI'
    this.gateway = opts.gateway || null
    this.autoUpdate = opts.autoUpdate !== false
    this.upnpPermanentFallback = opts.upnpPermanentFallback || false

    // Refresh the mapping 10 minutes before the end of its lifetime
    this._timeout = (this.ttl - 600) * 1000
    this._destroyed = false
    this._openPorts = []
    this._upnpIntervals = {}
    this._pmpIntervals = {}
    this._pmpClient = null
    this._upnpClient = null

    // Setup NAT-PMP Client
    this.enablePMP = opts.enablePMP !== false
    if (this.enablePMP && typeof v4 === 'function') {
      try {
        // Lookup gateway IP
        const results = v4()
        this._pmpClient = new NatPMP(results.gateway)
      } catch (err) {
        debug('Could not find gateway IP for NAT-PMP', err)
        this._pmpClient = null
      }
    }

    this.enableUPNP = opts.enableUPNP !== false
    if (this.enableUPNP) {
      // Setup UPnP Client
      this._upnpClient = new NatUPNP({ permanentFallback: this.upnpPermanentFallback })
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
      const newOpts = { ...opts }
      this._openPorts.push(newOpts)
      const response = await this._map(opts)
      if (!response[0]) {
        arrayRemove(this._openPorts, this._openPorts.indexOf(newOpts))
        return false
      }
    } else {
      // UDP & TCP

      // Map UDP
      const newOptsUDP = { ...opts }
      newOptsUDP.protocol = 'UDP'
      this._openPorts.push(newOptsUDP)
      let response = await this._map(newOptsUDP)
      if (!response[0]) {
        arrayRemove(this._openPorts, this._openPorts.indexOf(newOptsUDP))
        return false
      }

      // Map TCP
      const newOptsTCP = { ...opts }
      newOptsTCP.protocol = 'TCP'
      this._openPorts.push(newOptsTCP)
      response = await this._map(newOptsTCP)
      if (!response[0]) {
        arrayRemove(this._openPorts, this._openPorts.findIndex((o) => {
          return (o.publicPort === newOptsTCP.publicPort) &&
            (o.privatePort === newOptsTCP.privatePort) &&
            (o.protocol === newOptsTCP.protocol || newOptsTCP.protocol == null)
        }))
        return false
      }
    }
    return true
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
      const response = await this._unmap(opts)
      return response[0]
    } else {
      // UDP & TCP
      const newOptsUDP = { ...opts }
      newOptsUDP.protocol = 'UDP'
      let response = await this._unmap(newOptsUDP)
      if (!response[0]) return false
      const newOptsTCP = { ...opts }
      newOptsTCP.protocol = 'TCP'
      response = await this._unmap(newOptsTCP)
      if (!response[0]) return false
      return true
    }
  }

  async destroy () {
    if (this._destroyed) throw new Error('client already destroyed')

    // Unmap all ports
    const openPortsCopy = [...this._openPorts]

    for (const openPort of openPortsCopy) {
      try {
        await this.unmap(openPort)
      } catch (e) {
        debug('failed to unmap port public %d private %d protocol %s during destruction', openPort.publicPort, openPort.privatePort, openPort.protocol)
      }
    }

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

    return true
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
    if (this._destroyed) throw new Error('client is destroyed')
    try {
      if (this._pmpClient) {
        const pmpSuccess = await this._pmpMap(opts)
        if (pmpSuccess) return [true, null]
        debug('NAT-PMP port mapping failed')
      }
      if (this._upnpClient) {
        const upnpSuccess = await this._upnpMap(opts)
        if (upnpSuccess) return [true, null]
        debug('NAT-UPNP port mapping failed')
      }
      return [false, new Error('no protocols succeeded')]
    } catch (error) {
      return [false, error]
    }
  }

  async _pmpIp () {
    if (this._destroyed) throw new Error('client is destroyed')
    try {
      if (this._pmpClient) {
        const pmpTimeout = new Promise((resolve, reject) => {
          setTimeout(() => {
            this._pmpClient.close()
            const err = new Error('timeout')
            debug(
              'Error getting external ip using NAT-PMP:',
              err.message
            )
            reject(err)
          }, 1000).unref?.()
        })

        const ip = await Promise.race([this._pmpClient.externalIp(), pmpTimeout])
        if (ip) return ip
        debug('NAT-PMP getting public ip failed')
      }
    } catch (err) {}
    return ''
  }

  async _upnpIp () {
    if (this._destroyed) throw new Error('client is destroyed')
    try {
      if (this._upnpClient) {
        const ip = await this._upnpClient.externalIp()
        if (ip) return ip
        debug('NAT-UPNP getting public ip failed')
      }
    } catch (err) {}
    return ''
  }

  async externalIp () {
    if (this._destroyed) throw new Error('client is destroyed')
    try {
      if (this._pmpClient) {
        debug('getting ip via NAT-PMP')
        const ip = await this._pmpIp()
        if (ip) return ip
        debug('getting ip failed via NAT-PMP')
      }
      if (this._upnpClient) {
        debug('getting ip via NAT-UPNP')
        const ip = await this._upnpIp()
        if (ip) return ip
        debug('getting public ip failed via NAT-UPNP')
      }
    } catch (err) {}
    return ''
  }

  async _unmap (opts) {
    if (this._destroyed) throw new Error('client is destroyed')
    try {
      if (this._pmpClient) {
        const pmpSuccess = await this._pmpUnmap(opts)
        if (pmpSuccess) {
          return [true, null]
        }
        debug('NAT-PMP port unmapping failed')
      }
      if (this._upnpClient) {
        const upmpSuccess = await this._upnpUnmap(opts)
        if (upmpSuccess) {
          return [true, null]
        }
        debug('NAT-UPNP port unmapping failed')
      }
      return [false, new Error('no protocols succeeded')]
    } catch (error) {
      return [false, error]
    }
  }

  async _upnpMap (opts) {
    if (this._destroyed) throw new Error('client is destroyed')
    debug('Mapping public port %d to private port %d by %s using UPnP', opts.publicPort, opts.privatePort, opts.protocol)

    try {
      await this._upnpClient.portMapping({
        public: opts.publicPort,
        private: opts.privatePort,
        description: opts.description,
        protocol: opts.protocol,
        ttl: opts.ttl
      })
    } catch (err) {
      debug(
        'Error unmapping port %d:%d using NAT-UPNP:',
        opts.publicPort,
        opts.privatePort,
        err.message
      )
      return false
    }

    if (this.autoUpdate) {
      this._upnpIntervals[opts.publicPort + ':' + opts.privatePort + '-' + opts.protocol] = setInterval(
        () => this._upnpMap(opts),
        this._timeout
      ).unref?.()
    }

    debug('Port %d:%d for protocol %s mapped on router using UPnP', opts.publicPort, opts.privatePort, opts.protocol)

    return true
  }

  async _pmpMap (opts) {
    if (this._destroyed) throw new Error('client is destroyed')
    debug(
      'Mapping public port %d to private port %d by %s using NAT-PMP',
      opts.publicPort,
      opts.privatePort,
      opts.protocol
    )

    // If we come from a timeouted (or error) request, we need to reconnect
    if (this._pmpClient && this._pmpClient.socket == null) {
      this._pmpClient = new NatPMP(this._pmpClient.gateway)
    }

    const pmpTimeout = new Promise((resolve, reject) => {
      setTimeout(() => {
        this._pmpClient.close()
        const err = new Error('timeout')
        reject(err)
      }, 1000).unref?.()
    })

    try {
      await Promise.race([
        this._pmpClient.portMapping({
          public: opts.publicPort,
          private: opts.privatePort,
          type: opts.protocol,
          ttl: opts.ttl
        }),
        pmpTimeout
      ])
    } catch (err) {
      this._pmpClient.close()
      debug(
        'Error mapping port %d:%d using NAT-PMP:',
        opts.publicPort,
        opts.privatePort,
        err.message
      )
      return false
    }

    if (this.autoUpdate) {
      this._pmpIntervals[
        opts.publicPort + ':' + opts.privatePort + '-' + opts.protocol
      ] = setInterval(
        async () => {
          try {
            await this._pmpMap.bind(this, opts)
          } catch (err) {
            // Handle any errors here
          }
        },
        this._timeout
      ).unref?.()
    }

    debug(
      'Port %d:%d for protocol %s mapped on router using NAT-PMP',
      opts.publicPort,
      opts.privatePort,
      opts.protocol
    )

    return true
  }

  async _upnpUnmap (opts) {
    if (this._destroyed) throw new Error('client is destroyed')
    debug('Unmapping public port %d to private port %d by %s using UPnP', opts.publicPort, opts.privatePort, opts.protocol)

    try {
      await this._upnpClient.portUnmapping({
        public: opts.publicPort,
        private: opts.privatePort,
        protocol: opts.protocol
      })
    } catch (err) {
      debug(
        'Error unmapping port %d:%d using NAT-UPNP:',
        opts.publicPort,
        opts.privatePort,
        err.message
      )
      return false
    }

    // Clear intervals
    const key = opts.publicPort + ':' + opts.privatePort + '-' + opts.protocol
    if (this._upnpIntervals[key]) {
      clearInterval(this._upnpIntervals[key])
      delete this._upnpIntervals[key]
    }

    debug('Port %d:%d for protocol %s unmapped on router using UPnP', opts.publicPort, opts.privatePort, opts.protocol)

    return true
  }

  async _pmpUnmap (opts) {
    if (this._destroyed) throw new Error('client is destroyed')
    debug(
      'Unmapping public port %d to private port %d by %s using NAT-PMP',
      opts.publicPort,
      opts.privatePort,
      opts.protocol
    )

    // If we come from a timeouted (or error) request, we need to reconnect
    if (this._pmpClient && this._pmpClient.socket == null) {
      this._pmpClient = new NatPMP(this._pmpClient.gateway)
    }

    const pmpTimeout = new Promise((resolve, reject) => {
      setTimeout(() => {
        this._pmpClient.close()
        const err = new Error('timeout')
        debug(
          'Error unmapping port %d:%d using NAT-PMP:',
          opts.publicPort,
          opts.privatePort,
          err.message
        )
        reject(err)
      }, 1000).unref?.()
    })

    try {
      await Promise.race([
        this._pmpClient.portUnmapping({
          public: opts.publicPort,
          private: opts.privatePort,
          type: opts.protocol
        }),
        pmpTimeout
      ])
    } catch (err) {
      this._pmpClient.close()
      debug(
        'Error unmapping port %d:%d using NAT-PMP:',
        opts.publicPort,
        opts.privatePort,
        err.message
      )
      return false
    }

    // Clear intervals
    const key = opts.publicPort + ':' + opts.privatePort + '-' + opts.protocol
    if (this._pmpIntervals[key]) {
      clearInterval(this._pmpIntervals[key])
      delete this._pmpIntervals[key]
    }

    debug(
      'Port %d:%d for protocol %s unmapped on router using NAT-PMP',
      opts.publicPort,
      opts.privatePort,
      opts.protocol
    )

    return true
  }

  _checkPort (publicPort, cb) {
    // TOOD: check port
  }
}
