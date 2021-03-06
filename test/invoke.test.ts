import { Machine, actions } from '../src/index';
import { interpret } from '../src/interpreter';
import { assign, sendParent, send } from '../src/actions';
import { assert } from 'chai';

const childMachine = Machine({
  id: 'child',
  initial: 'init',
  states: {
    init: {
      onEntry: [actions.sendParent('INC'), actions.sendParent('INC')],
      on: {
        FORWARD_DEC: {
          actions: [
            actions.sendParent('DEC'),
            actions.sendParent('DEC'),
            actions.sendParent('DEC')
          ]
        }
      }
    }
  }
});

const parentMachine = Machine(
  {
    id: 'parent',
    context: { count: 0 },
    initial: 'start',
    states: {
      start: {
        invoke: {
          src: 'child',
          id: 'someService',
          forward: true
        },
        on: {
          INC: { actions: assign({ count: ctx => ctx.count + 1 }) },
          DEC: { actions: assign({ count: ctx => ctx.count - 1 }) },
          FORWARD_DEC: undefined,
          STOP: 'stop'
        }
      },
      stop: {}
    }
  },
  {
    services: {
      child: childMachine
    }
  }
);

const user = { name: 'David' };

const fetchMachine = Machine<{ userId: string | undefined }>({
  id: 'fetch',
  context: {
    userId: undefined
  },
  initial: 'pending',
  states: {
    pending: {
      onEntry: send({ type: 'RESOLVE', user }),
      on: {
        RESOLVE: {
          target: 'success',
          cond: ctx => ctx.userId !== undefined
        }
      }
    },
    success: {
      type: 'final',
      data: { user: (_, e) => e.user }
    },
    failure: {
      onEntry: sendParent('REJECT')
    }
  }
});

const fetcherMachine = Machine({
  id: 'fetcher',
  initial: 'idle',
  context: {
    selectedUserId: '42',
    user: undefined
  },
  states: {
    idle: {
      on: {
        GO_TO_WAITING: 'waiting',
        GO_TO_WAITING_MACHINE: 'waitingInvokeMachine'
      }
    },
    waiting: {
      invoke: {
        src: fetchMachine,
        data: {
          userId: ctx => ctx.selectedUserId
        },
        onDone: {
          target: 'received',
          cond: (_, e) => {
            // Should receive { user: { name: 'David' } } as event data
            return e.data.user.name === 'David';
          }
        }
      }
    },
    waitingInvokeMachine: {
      invoke: {
        src: fetchMachine.withContext({ userId: '55' }),
        onDone: 'received'
      }
    },
    received: {
      type: 'final'
    }
  }
});

// @ts-ignore
const intervalMachine = Machine({
  id: 'interval',
  initial: 'counting',
  context: {
    interval: 10,
    count: 0
  },
  states: {
    counting: {
      invoke: {
        id: 'intervalService',
        src: ctx => cb => {
          const interval = setInterval(() => {
            cb('INC');
          }, ctx.interval);

          return () => clearInterval(interval);
        }
      },
      on: {
        '': {
          target: 'finished',
          cond: ctx => ctx.count === 3
        },
        INC: { actions: assign({ count: ctx => ctx.count + 1 }) },
        SKIP: 'wait'
      }
    },
    wait: {
      on: {
        // this should never be called if interval service is properly disposed
        INC: { actions: assign({ count: ctx => ctx.count + 1 }) }
      },
      after: {
        50: 'finished'
      }
    },
    finished: {
      type: 'final'
    }
  }
});

describe('invoke', () => {
  it('should start services (external machines)', () => {
    const service = interpret(parentMachine).start();
    // 1. The 'parent' machine will enter 'start' state
    // 2. The 'child' service will be run with ID 'someService'
    // 3. The 'child' machine will enter 'init' state
    // 4. The 'onEntry' action will be executed, which sends 'INC' to 'parent' machine twice
    // 5. The context will be updated to increment count to 2

    assert.deepEqual(service.state.context, { count: 2 });
  });

  it('should forward events to services if forward: true', () => {
    const service = interpret(parentMachine).start();

    service.send('FORWARD_DEC');
    // 1. The 'parent' machine will not do anything (inert transition)
    // 2. The 'FORWARD_DEC' event will be forwarded to the 'child' machine (forward: true)
    // 3. On the 'child' machine, the 'FORWARD_DEC' event sends the 'DEC' action to the 'parent' thrice
    // 4. The context of the 'parent' machine will be updated from 2 to -1

    assert.deepEqual(service.state.context, { count: -1 });
  });

  it('should start services (explicit machine, invoke = config)', done => {
    interpret(fetcherMachine)
      .onDone(() => {
        done();
      })
      .start()
      .send('GO_TO_WAITING');
  });

  it('should start services (explicit machine, invoke = machine)', done => {
    interpret(fetcherMachine)
      .onDone(_ => {
        done();
      })
      .start()
      .send('GO_TO_WAITING_MACHINE');
  });

  it('should use the service overwritten by withConfig', () => {
    const service = interpret(
      parentMachine.withConfig({
        services: {
          child: Machine({
            id: 'child',
            initial: 'init',
            states: {
              init: {
                onEntry: [actions.sendParent('STOP')]
              }
            }
          })
        }
      })
    ).start();

    assert.deepEqual(service.state.value, 'stop');
  });

  describe('with promises', () => {
    const invokePromiseMachine = Machine({
      id: 'invokePromise',
      initial: 'pending',
      context: {
        id: 42,
        succeed: true
      },
      states: {
        pending: {
          invoke: {
            src: ctx =>
              new Promise(resolve => {
                if (ctx.succeed) {
                  resolve(ctx.id);
                } else {
                  throw new Error(`failed on purpose for: ${ctx.id}`);
                }
              }),
            onDone: {
              target: 'success',
              cond: (ctx, e) => {
                return e.data === ctx.id;
              }
            },
            onError: 'failure'
          }
        },
        success: {
          type: 'final'
        },
        failure: {
          type: 'final'
        }
      }
    });

    it('should be invoked with a promise factory and resolve through onDone', done => {
      interpret(invokePromiseMachine)
        .onDone(() => done())
        .start();
    });

    it('should be invoked with a promise factory and reject with ErrorExecution', done => {
      interpret(invokePromiseMachine.withContext({ id: 31, succeed: false }))
        .onDone(() => done())
        .start();
    });
  });

  describe('with callbacks', () => {
    it('should treat a callback source as an event stream', done => {
      interpret(intervalMachine)
        .onDone(() => done())
        .start();
    });

    it('should dispose of the callback (if disposal function provided)', done => {
      const service = interpret(intervalMachine)
        .onDone(() => {
          // if intervalService isn't disposed after skipping, 'INC' event will
          // keep being sent
          assert.equal(
            service.state.context.count,
            0,
            'should exit interval service before the first event is sent'
          );
          done();
        })
        .start();

      // waits 50 milliseconds before going to final state.
      service.send('SKIP');
    });
  });
});
