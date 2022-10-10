const _ = require('lodash');
const fs = require('fs');
const util = require('util');
function debug(...args) {
  fs.writeFileSync(1, `${util.format(...args)}\n`, { flag: 'a' });
}
const eventsReducer = (state, evt) => {
  const { type, payload } = evt;

  if (type === 'EarlyTermination') state.events.push(evt);
  if (type === 'UncaughtError') state.events.push(evt);

  if (type === 'ConsoleLog') state.events.push(evt);
  if (type === 'ConsoleWarn') state.events.push(evt);
  if (type === 'ConsoleError') state.events.push(evt);

  if (type === 'EnterFunction') {
    if (state.prevEvt.type === 'BeforePromise') {
      state.events.push({ type: 'DequeueMicrotask', payload: {} });
      state.events.push(evt);
    } else if (state.prevEvt.type === 'BeforeMicrotask') {
      // const isFromNextTick = state.events.find((event) => event.type==='InitMicrotask' && event.payload.asyncID===state.prevEvt.payload.asyncID);
      //   if (isFromNextTick)
          state.events.push({ type: 'DequeueMicrotask', payload: {} }); // TODO: Avoid dequeueing for nextTick
      state.events.push(evt);
    } else if (state.prevEvt.type === 'BeforeTimeout') {
      state.events.push({ type: 'EnqueueTask', payload: evt.payload });
      state.events.push(evt);
      state.events.push({ type: 'DequeueTask', payload: evt.payload });
    } else {
      state.events.push(evt);
    }
  }
  if (type == 'ExitFunction') state.events.push(evt);
  if (type == 'ErrorFunction') state.events.push(evt);

  if (type === 'InitPromise') state.events.push(evt);
  if (type === 'ResolvePromise') {
    state.events.push(evt);

    const microtaskInfo = state.parentsIdsOfPromisesWithInvokedCallbacks.find(
      ({ asyncID }) => asyncID === payload.asyncID
    );

    if (microtaskInfo) {
      state.events.push({
        type: 'EnqueueMicrotask',
        payload: { name: microtaskInfo.name },
      });
    }
  }
  if (type === 'BeforePromise') state.events.push(evt);
  if (type === 'AfterPromise') state.events.push(evt);

  if (type === 'InitMicrotask') {
    state.events.push(evt);

    const microtaskInfo = state.parentsIdsOfMicrotasks.find(
      ({ asyncID }) => asyncID === payload.asyncID
    );

    if (
      (microtaskInfo) || 
      (state.prevEvt.type!=='InitPromise') ||
      (state.prevEvt.type==='EnterFunction' && state.prevEvt.payload.name==='queueMicrotask')) {
      state.events.push({
        type: 'EnqueueMicrotask',
        payload: { name: microtaskInfo?.name || 'microtask' },  // TODO: Get callback name for q'd µtasks
      });
    }
  }
  if (type === 'BeforeMicrotask') {
  //   if (state.prevEvt.type === 'InitMicrotask') {   // TODO: Fix for nextTick
  //     state.events.push({
  //       type: 'EnqueueMicrotask',
  //       payload: { name: evt.payload.name },
  //     });
  //   }
    state.events.push(evt);
  }
  if (type === 'AfterMicrotask') state.events.push(evt);

  if (type === 'InitTimeout') state.events.push(evt);
  if (type === 'BeforeTimeout') {
    state.events.push({ type: 'Rerender', payload: {} });
    state.events.push(evt);
  }

  if (type === 'InitImmediate') {
    state.events.push(evt);
    state.events.push({ type: 'EnqueueTask', payload: evt.payload });
  }
  if (type === 'BeforeImmediate') {
    state.events.push(evt);
    state.events.push({ type: 'DequeueTask', payload: evt.payload });
  }

  state.prevEvt = evt;

  return state;
};

// TODO: Return line:column numbers for func calls

const reduceEvents = (events) => {
  // For some reason, certain Promises (e.g. from `fetch` calls) seem to
  // resolve multiple times. I don't know why this happens, but it screws things
  // up for the view layer, so we'll just take the last one ¯\_(ツ)_/¯
  events = _(events)
    .reverse()
    .uniqWith(
      (aEvt, bEvt) =>
        aEvt.type === 'ResolvePromise' &&
        bEvt.type === 'ResolvePromise' &&
        aEvt.payload.asyncID === bEvt.payload.asyncID
    )
    .reverse()
    .value();

  // Before we reduce the events, we need to figure out when Microtasks
  // were enqueued.
  //
  // A Microtask was enqueued when its parent resolved iff the child Promise
  // of the parent had its callback invoked.
  //
  // A Promise has its callback invoked iff a function was entered immediately
  // after the Promise's `BeforePromise` event.

  const resolvedPromiseIds = events
    .filter(({ type }) => type === 'ResolvePromise')
    .map(({ payload: { asyncID } }) => asyncID);

  const promisesWithInvokedCallbacksInfo = events
    .filter(({ type }) =>
      [
        'BeforePromise',
        'EnterFunction',
        'ExitFunction',
        'ResolvePromise',
      ].includes(type)
    )
    .map((evt, idx, arr) => {
      return evt.type === 'BeforePromise' &&
        (arr[idx + 1] || {}).type === 'EnterFunction'
        ? [evt, arr[idx + 1]]
        : undefined;
    })
    .filter(Boolean)
    .map(([beforePromiseEvt, enterFunctionEvt]) => ({
      asyncID: beforePromiseEvt.payload.asyncID,
      name: enterFunctionEvt.payload.name,
    }));

  const promiseChildIdToParentId = {};
  events
    .filter(({ type }) => type === 'InitPromise')
    .forEach(({ payload: { asyncID, parentId } }) => {
      promiseChildIdToParentId[asyncID] = parentId;
    });

  const parentsIdsOfPromisesWithInvokedCallbacks = promisesWithInvokedCallbacksInfo.map(
    ({ asyncID: childId, name }) => ({
      asyncID: promiseChildIdToParentId[childId],
      name,
    })
  );

  const microtasksWithInvokedCallbacksInfo = events
    .filter(({ type }) =>
      [
        'InitMicrotask',
        'BeforeMicrotask',
        'AfterMicrotask',
        'EnterFunction',
        'ExitFunction',
        'InitImmediate',
        'BeforeImmediate',
      ].includes(type)
    )
    .map((evt, idx, arr) =>
      evt.type === 'BeforeMicrotask' &&
      (arr[idx + 1] || {}).type === 'EnterFunction'
        ? [evt, arr[idx + 1]]
        : undefined
    )
    .filter(Boolean)
    .map(([beforeMicrotaskEvt, enterFunctionEvt]) => ({
      asyncID: beforeMicrotaskEvt.payload.asyncID,
      name: enterFunctionEvt.payload.name,
    }));

  const microtaskChildIdToParentId = {};
  events
    .filter(({ type }) => type === 'InitMicrotask')
    .forEach(({ payload: { asyncID, parentId } }) => {
      microtaskChildIdToParentId[asyncID] = parentId;
    });

  const parentsIdsOfMicrotasks = microtasksWithInvokedCallbacksInfo.map(
    ({ asyncID: childId, name }) => ({
      asyncID: microtaskChildIdToParentId[childId],
      name,
    })
  );

  // console.log({
  //   resolvedPromiseIds,
  //   promisesWithInvokedCallbacksInfo,
  //   parentsIdsOfPromisesWithInvokedCallbacks,
  //   parentsIdsOfMicrotasks,
  // });

  return events.reduce(eventsReducer, {
    events: [],
    parentsIdsOfPromisesWithInvokedCallbacks,
    parentsIdsOfMicrotasks,
    prevEvt: {},
  }).events;
};

module.exports = { reduceEvents };
