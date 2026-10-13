# dd-trace grpc client: duplicate spans with ESM import

The app runs with `node --import dd-trace/register.js` and loads `@grpc/grpc-js` with an ESM `import`. In that setup, each gRPC client call creates two nested `grpc.client` spans with the same resource. If the app loads `@grpc/grpc-js` with `require`, each call creates one span.

## Versions

- dd-trace 6.20.1 and 6.20.0 (master at `5a89269` has the same code)
- @grpc/grpc-js 1.14.5
- Node 22.19.0, 24.21.0, 26.3.0

## Run

```sh
npm install
npm run -s repro:import  | jq -c '.traces[][] | {name, resource, span_id, parent_id}'
npm run -s repro:require | jq -c '.traces[][] | {name, resource, span_id, parent_id}'
```

`repro.mjs` starts a gRPC server in the same process and makes one unary call. The `log` exporter writes the spans to stdout, so the script does not need an agent.

## Actual

```
== import
{"name":"grpc.client","resource":"/test.Echo/Echo","span_id":"20b64b4af0aadf61","parent_id":"0000000000000000"}
{"name":"grpc.client","resource":"/test.Echo/Echo","span_id":"1cd7b1f5fa64a785","parent_id":"20b64b4af0aadf61"}
== require
{"name":"grpc.client","resource":"/test.Echo/Echo","span_id":"6563524cf15e009e","parent_id":"0000000000000000"}
```

## Expected

One `grpc.client` span per call in both modes.

## Cause

[`patch()` in `grpc/client.js`](https://github.com/DataDog/dd-trace-js/blob/5a89269f145091995493e6adadf104ba12a8c5d3/packages/datadog-instrumentations/src/grpc/client.js#L246-L256) runs two times on the same `grpc.Client.prototype`:

1. The require hook calls it with `module.exports`.
2. import-in-the-middle calls it with the ESM namespace object.

[`hook.js`](https://github.com/DataDog/dd-trace-js/blob/5a89269f145091995493e6adadf104ba12a8c5d3/packages/datadog-instrumentations/src/helpers/hook.js#L69) prevents a second patch only when it gets the same exports object again. The namespace and `module.exports` are different objects, but `namespace.Client === module.exports.Client`. Thus `shimmer.wrap` wraps `makeUnaryRequest`, `makeClientStreamRequest`, `makeServerStreamRequest` and `makeBidiStreamRequest` two times. Each wrapper publishes `apm:grpc:client:request:start`, so each call creates two spans.

[`mariadb-bundle.js`](https://github.com/DataDog/dd-trace-js/blob/5a89269f145091995493e6adadf104ba12a8c5d3/packages/datadog-instrumentations/src/mariadb-bundle.js#L1546) has a guard for this case (`if (isIitm) return mariadb`). The grpc client instrumentation has no guard.

The problem occurs only when the code calls `Client.prototype.make*Request` directly, as `nice-grpc` and `@protobuf-ts/grpc-transport` do. Service clients from `makeGenericClientConstructor` and `loadPackageDefinition` are not affected. These clients call the unwrapped `make*Request` functions that grpc-js keeps when it loads, and `wrapMethod` adds one span.

## Fix

```diff
 function patch (hasPeer = false) {
   return function patch (grpc) {
     const proto = grpc.Client.prototype

+    if (instances.has(proto)) return grpc
+
     instances.set(proto, grpc)
```

`instances` is the `WeakMap` that `patch()` already fills. With this change, both modes create one span per call.
