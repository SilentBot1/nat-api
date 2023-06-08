import NatAPI from '../index.js'

const port = 6690

const enablePMP = [true, false]
const protocols = ['TCP', 'UDP']

const test = async (protocol, opts) => {
  const client = new NatAPI({ enablePMP: opts.enablePMP })

  const options = { publicPort: port, privatePort: port, protocol }
  await client.map(options)
  console.log(`Port ${port} mapped to ${port} ${protocol} via ${opts.enablePMP ? 'PMP' : 'UPnP'}`)
  await client.unmap(options)
  console.log(`Port ${port} unmapped from ${port} ${protocol} via ${opts.enablePMP ? 'PMP' : 'UPnP'}`)

  await client.destroy()
}

const main = async () => {
  for (const usePMP of enablePMP) {
    for (const protocol of protocols) {
      await test(protocol, { enablePMP: usePMP })
    }
  }
}

main().catch(console.error)
