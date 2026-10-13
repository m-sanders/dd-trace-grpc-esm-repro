import tracer from 'dd-trace'
import { createRequire } from 'node:module'

tracer.init({ plugins: false, startupLogs: false, flushInterval: 0 })
tracer.use('grpc', { server: { enabled: false } })

const mode = process.argv[2] ?? 'import'
const grpc = mode === 'require'
  ? createRequire(import.meta.url)('@grpc/grpc-js')
  : await import('@grpc/grpc-js')

const identity = (b) => b
const service = {
  Echo: {
    path: '/test.Echo/Echo',
    requestStream: false,
    responseStream: false,
    requestSerialize: identity,
    requestDeserialize: identity,
    responseSerialize: identity,
    responseDeserialize: identity
  }
}

const server = new grpc.Server()
server.addService(service, { Echo: (call, cb) => cb(null, call.request) })
const port = await new Promise((resolve, reject) =>
  server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, p) => err ? reject(err) : resolve(p)))

// Calling makeUnaryRequest directly matches what nice-grpc and @protobuf-ts/grpc-transport do.
const client = new grpc.Client(`127.0.0.1:${port}`, grpc.credentials.createInsecure())
await new Promise((resolve, reject) =>
  client.makeUnaryRequest('/test.Echo/Echo', identity, identity, Buffer.from('hi'), (err) => err ? reject(err) : resolve()))

client.close()
server.forceShutdown()
setTimeout(() => process.exit(0), 200)
