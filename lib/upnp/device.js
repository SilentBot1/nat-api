const fetch = require('node-fetch')
const xml2js = require('xml2js')

class Device {
  constructor (url) {
    this.url = url
    this.services = [
      'urn:schemas-upnp-org:service:WANIPConnection:1',
      'urn:schemas-upnp-org:service:WANIPConnection:2',
      'urn:schemas-upnp-org:service:WANPPPConnection:1'
    ]
  }

  run (action, args, callback) {
    const self = this

    this._getService(this.services, function (err, info) {
      if (err) return callback(err)

      const body = '<?xml version="1.0"?>' +
               '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
                 's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
                 '<s:Body>' +
                   '<u:' + action + ' xmlns:u=' + JSON.stringify(info.service) + '>' +
                     args.map((args) => {
                       return '<' + args[0] + '>' +
                             (args[1] ? args[1] : '') +
                             '</' + args[0] + '>'
                     }).join('') +
                   '</u:' + action + '>' +
                 '</s:Body>' +
               '</s:Envelope>'

      fetch(info.controlURL, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          'Content-Length': Buffer.byteLength(body),
          Connection: 'close',
          SOAPAction: JSON.stringify(info.service + '#' + action)
        },
        body
      })
        .then(res => {
          if (res.status !== 200) {
            throw new Error('Request failed: ' + res.status)
          }
          return res.text()
        })
        .then(data => {
          const parser = new xml2js.Parser(xml2js.defaults['0.1'])
          parser.parseString(data, function (err, body) {
            if (err) return callback(err)

            const soapns = self._getNamespace(
              body,
              'http://schemas.xmlsoap.org/soap/envelope/'
            )

            callback(null, body[soapns + 'Body'])
          })
        })
        .catch(err => callback(err))
    })
  }

  _getService (types, callback) {
    const self = this

    this._getXml(this.url, function (err, info) {
      if (err) return callback(err)

      const s = self._parseDescription(info).services.filter(function (service) {
        return types.indexOf(service.serviceType) !== -1
      })

      // Use the first available service
      if (s.length === 0 || !s[0].controlURL || !s[0].SCPDURL) {
        return callback(new Error('Service not found'))
      }

      const base = new URL(info.baseURL || self.url)
      function addPrefix (u) {
        let uri
        try {
          uri = new URL(u)
        } catch (err) {
          // Is only the path of the URL
          uri = new URL(u, base.href)
        }

        uri.host = uri.host || base.host
        uri.protocol = uri.protocol || base.protocol

        return uri.toString()
      }

      callback(null, {
        service: s[0].serviceType,
        SCPDURL: addPrefix(s[0].SCPDURL),
        controlURL: addPrefix(s[0].controlURL)
      })
    })
  }

  _getXml (url, callback) {
    fetch(url)
      .then(response => {
        if (response.status !== 200) {
          throw new Error('Request failed: ' + response.status)
        }
        return response.text()
      })
      .then(data => {
        const parser = new xml2js.Parser(xml2js.defaults['0.1'])
        parser.parseString(data, function (err, body) {
          if (err) {
            throw new Error(err)
          }
          callback(null, body)
        })
      })
      .catch(err => {
        callback(err)
      })
  }

  _parseDescription (info) {
    const services = []
    const devices = []

    function toArray (item) {
      return Array.isArray(item) ? item : [item]
    }

    function traverseServices (service) {
      if (!service) return
      services.push(service)
    }

    function traverseDevices (device) {
      if (!device) return
      devices.push(device)

      if (device.deviceList && device.deviceList.device) {
        toArray(device.deviceList.device).forEach(traverseDevices)
      }

      if (device.serviceList && device.serviceList.service) {
        toArray(device.serviceList.service).forEach(traverseServices)
      }
    }

    traverseDevices(info.device)

    return {
      services,
      devices
    }
  }

  _getNamespace (data, uri) {
    let ns

    if (data['@']) {
      Object.keys(data['@']).some(function (key) {
        if (!/^xmlns:/.test(key)) return false
        if (data['@'][key] !== uri) return false

        ns = key.replace(/^xmlns:/, '')
        return true
      })
    }

    return ns ? ns + ':' : ''
  }
}

module.exports = Device
