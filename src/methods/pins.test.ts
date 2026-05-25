import { describe, expect, it, vi } from 'vitest'

import pins, { addPin, addPins, deletePin, modifyPin, pinStates } from './pins.js'

describe('pins', () => {
  it('should export the pins function', () => {
    expect(pins).toBeTypeOf('function')
  })

  it('should export PIN write functions', () => {
    expect(addPin).toBeTypeOf('function')
    expect(addPins).toBeTypeOf('function')
    expect(modifyPin).toBeTypeOf('function')
    expect(deletePin).toBeTypeOf('function')
    expect(pinStates).toBeTypeOf('function')
  })

  it('adds a requested PIN through create, load, sync, update, sync, and verify', async () => {
    const context = {
      end: vi.fn(),
      get: vi.fn()
        .mockResolvedValueOnce({
          body: {
            loaded: [],
          },
        })
        .mockResolvedValueOnce({
          body: {
            loaded: [],
          },
        })
        .mockResolvedValueOnce({
          body: {
            loaded: [{ userID: 'user-1', slot: 27, pin: '222222', accessType: 'always' }],
          },
        }),
      post: vi.fn().mockResolvedValueOnce({
        body: { id: 'user-1', firstName: 'AccessCode', lastName: 'User1', slot: 27, pin: '111111' },
      }),
      put: vi.fn().mockResolvedValue({ body: { ok: true } }),
    }

    const result = await addPin.call(context, false, 'lock-1', '222222')

    expect(context.post).toHaveBeenCalledWith('/unverifiedusers', {
      deviceID: 'lock-1',
      deviceType: 'lock',
      firstName: 'AccessCode',
      lastName: 'User1',
      credentialType: 'pin',
      userApiType: 1,
    }, '2.0.0')
    expect(context.put).toHaveBeenNthCalledWith(1, '/locks/lock-1/users/user-1/credentials', {
      type: 'pin',
      state: 'load',
      action: 'intent',
      pin: '111111',
      slot: '27',
      accessType: 'always',
      userApiType: 1,
    })
    expect(context.put).toHaveBeenNthCalledWith(2, '/locks/lock-1/pins/sync', null)
    expect(context.put).toHaveBeenNthCalledWith(3, '/locks/lock-1/users/user-1/credentials', {
      type: 'pin',
      state: 'update',
      action: 'intent',
      pin: '222222',
      slot: '27',
      accessType: 'always',
    })
    expect(context.put).toHaveBeenNthCalledWith(4, '/locks/lock-1/pins/sync', null)
    expect(context.put).toHaveBeenCalledTimes(4)
    expect(result).toMatchObject({
      lockId: 'lock-1',
      userId: 'user-1',
      slot: 27,
      pin: '222222',
      previousPin: '111111',
      generatedPin: '111111',
    })
    expect(context.end).toHaveBeenCalledOnce()
  })

  it('uses the lowest available AccessCode User number from existing PIN names when adding', async () => {
    const context = {
      end: vi.fn(),
      get: vi.fn()
        .mockResolvedValueOnce({
          body: {
            loaded: [
              { userID: 'existing-1', slot: 20, pin: '100001', firstName: 'AccessCode', lastName: 'User1' },
              { userID: 'existing-2', slot: 21, pin: '100002', firstName: 'AccessCode', lastName: 'User3' },
              { userID: 'existing-3', slot: 22, pin: '100003', firstName: 'Someone', lastName: 'User99' },
            ],
          },
        })
        .mockResolvedValueOnce({
          body: {
            loaded: [
              { userID: 'existing-1', slot: 20, pin: '100001', firstName: 'AccessCode', lastName: 'User1' },
              { userID: 'existing-2', slot: 21, pin: '100002', firstName: 'AccessCode', lastName: 'User3' },
              { userID: 'existing-3', slot: 22, pin: '100003', firstName: 'Someone', lastName: 'User99' },
            ],
          },
        })
        .mockResolvedValueOnce({
          body: {
            loaded: [{ userID: 'user-1', slot: 27, pin: '222222', accessType: 'always' }],
          },
        }),
      post: vi.fn().mockResolvedValueOnce({
        body: { id: 'user-1', firstName: 'AccessCode', lastName: 'User2', slot: 27, pin: '111111' },
      }),
      put: vi.fn().mockResolvedValue({ body: { ok: true } }),
    }

    await addPin.call(context, false, 'lock-1', '222222')

    expect(context.post).toHaveBeenCalledWith('/unverifiedusers', {
      deviceID: 'lock-1',
      deviceType: 'lock',
      firstName: 'AccessCode',
      lastName: 'User2',
      credentialType: 'pin',
      userApiType: 1,
    }, '2.0.0')
  })

  it('adds multiple requested PINs with shared sync rounds', async () => {
    const context = {
      end: vi.fn(),
      get: vi.fn()
        .mockResolvedValueOnce({
          body: {
            loaded: [
              { userID: 'existing-1', slot: 20, pin: '100001', firstName: 'AccessCode', lastName: 'User2' },
            ],
          },
        })
        .mockResolvedValueOnce({
          body: {
            loaded: [
              { userID: 'user-1', slot: 27, pin: '111111', accessType: 'always', firstName: 'AccessCode', lastName: 'User1' },
              { userID: 'user-2', slot: 28, pin: '444444', accessType: 'always', firstName: 'AccessCode', lastName: 'User3' },
            ],
          },
        })
        .mockResolvedValueOnce({
          body: {
            loaded: [
              { userID: 'user-1', slot: 27, pin: '222222', accessType: 'always', firstName: 'AccessCode', lastName: 'User1' },
              { userID: 'user-2', slot: 28, pin: '333333', accessType: 'always', firstName: 'AccessCode', lastName: 'User3' },
            ],
          },
        }),
      post: vi.fn()
        .mockResolvedValueOnce({
          body: { id: 'user-1', firstName: 'AccessCode', lastName: 'User1', slot: 27, pin: '111111' },
        })
        .mockResolvedValueOnce({
          body: { id: 'user-2', firstName: 'AccessCode', lastName: 'User3', slot: 28, pin: '444444' },
        }),
      put: vi.fn().mockResolvedValue({ body: { ok: true } }),
    }

    const result = await addPins.call(context, false, 'lock-1', ['222222', '333333'])

    expect(context.post).toHaveBeenNthCalledWith(1, '/unverifiedusers', {
      deviceID: 'lock-1',
      deviceType: 'lock',
      firstName: 'AccessCode',
      lastName: 'User1',
      credentialType: 'pin',
      userApiType: 1,
    }, '2.0.0')
    expect(context.post).toHaveBeenNthCalledWith(2, '/unverifiedusers', {
      deviceID: 'lock-1',
      deviceType: 'lock',
      firstName: 'AccessCode',
      lastName: 'User3',
      credentialType: 'pin',
      userApiType: 1,
    }, '2.0.0')
    expect(context.put).toHaveBeenNthCalledWith(1, '/locks/lock-1/users/user-1/credentials', {
      type: 'pin',
      state: 'load',
      action: 'intent',
      pin: '111111',
      slot: '27',
      accessType: 'always',
      userApiType: 1,
    })
    expect(context.put).toHaveBeenNthCalledWith(2, '/locks/lock-1/users/user-2/credentials', {
      type: 'pin',
      state: 'load',
      action: 'intent',
      pin: '444444',
      slot: '28',
      accessType: 'always',
      userApiType: 1,
    })
    expect(context.put).toHaveBeenNthCalledWith(3, '/locks/lock-1/pins/sync', null)
    expect(context.put).toHaveBeenNthCalledWith(4, '/locks/lock-1/users/user-1/credentials', {
      type: 'pin',
      state: 'update',
      action: 'intent',
      pin: '222222',
      slot: '27',
      accessType: 'always',
    })
    expect(context.put).toHaveBeenNthCalledWith(5, '/locks/lock-1/users/user-2/credentials', {
      type: 'pin',
      state: 'update',
      action: 'intent',
      pin: '333333',
      slot: '28',
      accessType: 'always',
    })
    expect(context.put).toHaveBeenNthCalledWith(6, '/locks/lock-1/pins/sync', null)
    expect(context.put).toHaveBeenCalledTimes(6)
    expect(result).toMatchObject([
      {
        generatedPin: '111111',
        lockId: 'lock-1',
        pin: '222222',
        previousPin: '111111',
        slot: 27,
        userId: 'user-1',
      },
      {
        generatedPin: '444444',
        lockId: 'lock-1',
        pin: '333333',
        previousPin: '444444',
        slot: 28,
        userId: 'user-2',
      },
    ])
    expect(context.end).toHaveBeenCalledOnce()
  })

  it('wraps addPin failures with operation context and preserves HTTP details', async () => {
    const augustError = Object.assign(new Error('Duplicate PIN'), {
      body: { code: 'InvalidArgument', message: 'Duplicate PIN' },
      statusCode: 409,
    })
    const context = {
      end: vi.fn(),
      get: vi.fn()
        .mockResolvedValueOnce({
          body: {
            loaded: [],
          },
        })
        .mockResolvedValueOnce({
          body: {
            loaded: [],
          },
        }),
      post: vi.fn().mockRejectedValueOnce(augustError),
    }

    await expect(addPin.call(context, false, 'lock-1', '222222')).rejects.toMatchObject({
      body: { code: 'InvalidArgument', message: 'Duplicate PIN' },
      lockId: 'lock-1',
      name: 'PinOperationError',
      operation: 'addPin',
      statusCode: 409,
      step: 'create-user',
    })
    expect(context.end).toHaveBeenCalledOnce()
  })

  it('fails addPin before creating a user when the requested PIN exists in any credential state', async () => {
    const context = {
      end: vi.fn(),
      get: vi.fn().mockResolvedValueOnce({
        body: {
          loaded: [],
          updating: [{ userID: 'user-1', slot: 27, pin: '222222', state: 'updating' }],
        },
      }),
      post: vi.fn(),
      put: vi.fn(),
    }

    await expect(addPin.call(context, false, 'lock-1', '222222')).rejects.toMatchObject({
      lockId: 'lock-1',
      name: 'PinOperationError',
      operation: 'addPin',
      step: 'preflight-pin-state',
    })
    expect(context.post).not.toHaveBeenCalled()
    expect(context.put).not.toHaveBeenCalled()
    expect(context.end).toHaveBeenCalledOnce()
  })

  it('rolls back the generated credential when addPin cannot update it to the requested PIN', async () => {
    const duplicateError = Object.assign(new Error('Pin already exists. Must be deleted before it can be loaded again.'), {
      body: {
        code: 'InvalidArgument',
        message: 'Pin already exists. Must be deleted before it can be loaded again.',
      },
      statusCode: 409,
    })
    const context = {
      end: vi.fn(),
      get: vi.fn()
        .mockResolvedValueOnce({
          body: {
            loaded: [],
          },
        })
        .mockResolvedValueOnce({
          body: {
            loaded: [],
          },
        }),
      post: vi.fn().mockResolvedValueOnce({
        body: { id: 'user-1', firstName: 'AccessCode', lastName: 'User1', slot: 27, pin: '111111' },
      }),
      put: vi.fn()
        .mockResolvedValueOnce({ body: { ok: true } })
        .mockResolvedValueOnce({ body: { ok: true } })
        .mockRejectedValueOnce(duplicateError)
        .mockResolvedValueOnce({ body: { rollback: 'delete-intent' } })
        .mockResolvedValueOnce({ body: { rollback: 'sync' } })
        .mockResolvedValueOnce({ body: { rollback: 'delete-commit' } }),
    }

    await expect(addPin.call(context, false, 'lock-1', '222222')).rejects.toMatchObject({
      body: duplicateError.body,
      lockId: 'lock-1',
      name: 'PinOperationError',
      operation: 'addPin',
      rollback: {
        deleteCredential: { rollback: 'delete-intent' },
        sync: { rollback: 'sync' },
        commitCredential: { rollback: 'delete-commit' },
      },
      statusCode: 409,
      step: 'update-credential-intent',
    })
    expect(context.put).toHaveBeenNthCalledWith(4, '/locks/lock-1/users/user-1/credentials', {
      type: 'pin',
      state: 'delete',
      action: 'intent',
      pin: '111111',
      slot: '27',
    })
    expect(context.put).toHaveBeenNthCalledWith(5, '/locks/lock-1/pins/sync', null)
    expect(context.put).toHaveBeenNthCalledWith(6, '/locks/lock-1/users/user-1/credentials', {
      type: 'pin',
      state: 'delete',
      action: 'commit',
      pin: '111111',
      slot: '27',
    })
    expect(context.end).toHaveBeenCalledOnce()
  })

  it('commits addPin update when the requested PIN is not loaded after sync', async () => {
    const context = {
      end: vi.fn(),
      get: vi.fn()
        .mockResolvedValueOnce({
          body: {
            loaded: [],
          },
        })
        .mockResolvedValueOnce({
          body: {
            loaded: [],
          },
        })
        .mockResolvedValueOnce({
          body: {
            loaded: [],
          },
        })
        .mockResolvedValueOnce({
          body: {
            loaded: [{ userID: 'user-1', slot: 27, pin: '222222', accessType: 'always' }],
          },
        }),
      post: vi.fn().mockResolvedValueOnce({
        body: { id: 'user-1', firstName: 'AccessCode', lastName: 'User1', slot: 27, pin: '111111' },
      }),
      put: vi.fn().mockResolvedValue({ body: { ok: true } }),
    }

    const result = await addPin.call(context, false, 'lock-1', '222222')

    expect(context.put).toHaveBeenNthCalledWith(5, '/locks/lock-1/users/user-1/credentials', {
      type: 'pin',
      state: 'update',
      action: 'commit',
      pin: '222222',
      slot: '27',
      accessType: 'always',
    })
    expect(result).toMatchObject({
      lockId: 'lock-1',
      userId: 'user-1',
      slot: 27,
      pin: '222222',
      previousPin: '111111',
    })
  })

  it('treats an invalid addPin commit transition as success when the requested PIN is loaded', async () => {
    const invalidTransitionError = Object.assign(new Error('Pin cannot transition into desired state'), {
      statusCode: 409,
      body: {
        code: 'InvalidArgument',
        message: 'Pin is in a state in which desired action cannot be applied. It cannot transition into desired state from its current state.',
      },
    })
    const context = {
      end: vi.fn(),
      get: vi.fn()
        .mockResolvedValueOnce({
          body: {
            loaded: [],
          },
        })
        .mockResolvedValueOnce({
          body: {
            loaded: [],
          },
        })
        .mockResolvedValueOnce({
          body: {
            loaded: [],
          },
        })
        .mockResolvedValueOnce({
          body: {
            loaded: [{ userID: 'user-1', slot: 27, pin: '222222', accessType: 'always' }],
          },
        }),
      post: vi.fn().mockResolvedValueOnce({
        body: { id: 'user-1', firstName: 'AccessCode', lastName: 'User1', slot: 27, pin: '111111' },
      }),
      put: vi.fn()
        .mockResolvedValueOnce({ body: { ok: true } })
        .mockResolvedValueOnce({ body: { ok: true } })
        .mockResolvedValueOnce({ body: { ok: true } })
        .mockResolvedValueOnce({ body: { ok: true } })
        .mockRejectedValueOnce(invalidTransitionError),
    }

    const result = await addPin.call(context, false, 'lock-1', '222222')

    expect(context.put).toHaveBeenNthCalledWith(5, '/locks/lock-1/users/user-1/credentials', {
      type: 'pin',
      state: 'update',
      action: 'commit',
      pin: '222222',
      slot: '27',
      accessType: 'always',
    })
    expect(result).toMatchObject({
      lockId: 'lock-1',
      userId: 'user-1',
      slot: 27,
      pin: '222222',
      previousPin: '111111',
    })
    expect(result.commitCredential).toBeUndefined()
  })

  it('modifies a PIN by finding the existing slot and committing the update', async () => {
    const context = {
      end: vi.fn(),
      get: vi.fn()
        .mockResolvedValueOnce({
          body: {
            loaded: [{ userID: 'user-1', slot: 27, pin: '111111', accessType: 'always' }],
          },
        })
        .mockResolvedValueOnce({
          body: {
            loaded: [{ userID: 'user-1', slot: 27, pin: '222222', accessType: 'always' }],
          },
        }),
      put: vi.fn().mockResolvedValue({ body: { ok: true } }),
    }

    const result = await modifyPin.call(context, false, 'lock-1', '111111', '222222')

    expect(context.put).toHaveBeenNthCalledWith(1, '/locks/lock-1/users/user-1/credentials', {
      type: 'pin',
      state: 'update',
      action: 'intent',
      pin: '222222',
      slot: '27',
      accessType: 'always',
    })
    expect(context.put).toHaveBeenNthCalledWith(2, '/locks/lock-1/pins/sync', null)
    expect(context.put).toHaveBeenNthCalledWith(3, '/locks/lock-1/users/user-1/credentials', {
      type: 'pin',
      state: 'update',
      action: 'commit',
      pin: '222222',
      slot: '27',
      accessType: 'always',
    })
    expect(result).toMatchObject({
      lockId: 'lock-1',
      userId: 'user-1',
      slot: 27,
      pin: '222222',
      previousPin: '111111',
    })
    expect(context.end).toHaveBeenCalledOnce()
  })

  it('keeps the session open until modifyPin finishes every credential step', async () => {
    const events: string[] = []
    const context = {
      end: vi.fn(() => {
        events.push('end')
      }),
      get: vi.fn()
        .mockImplementationOnce(async () => {
          events.push('find-old')
          return {
            body: {
              loaded: [{ userID: 'user-1', slot: 27, pin: '111111', accessType: 'always' }],
            },
          }
        })
        .mockImplementationOnce(async () => {
          events.push('verify-new')
          return {
            body: {
              loaded: [{ userID: 'user-1', slot: 27, pin: '222222', accessType: 'always' }],
            },
          }
        }),
      put: vi.fn(async (endpoint: string) => {
        events.push(endpoint.endsWith('/pins/sync') ? 'sync' : 'credential')
        await Promise.resolve()
        return { body: { ok: true } }
      }),
    }

    await modifyPin.call(context, false, 'lock-1', '111111', '222222')

    expect(events).toEqual(['find-old', 'credential', 'sync', 'credential', 'verify-new', 'end'])
  })

  it('deletes a PIN by finding the existing slot and committing the delete', async () => {
    const context = {
      end: vi.fn(),
      get: vi.fn()
        .mockResolvedValueOnce({
          body: {
            loaded: [{ userID: 'user-1', slot: 27, pin: '111111' }],
          },
        })
        .mockResolvedValueOnce({
          body: {
            loaded: [],
          },
        }),
      put: vi.fn().mockResolvedValue({ body: { ok: true } }),
    }

    const result = await deletePin.call(context, false, 'lock-1', '111111')

    expect(context.put).toHaveBeenNthCalledWith(1, '/locks/lock-1/users/user-1/credentials', {
      type: 'pin',
      state: 'delete',
      action: 'intent',
      pin: '111111',
      slot: '27',
    })
    expect(context.put).toHaveBeenNthCalledWith(2, '/locks/lock-1/pins/sync', null)
    expect(context.put).toHaveBeenNthCalledWith(3, '/locks/lock-1/users/user-1/credentials', {
      type: 'pin',
      state: 'delete',
      action: 'commit',
      pin: '111111',
      slot: '27',
    })
    expect(result).toMatchObject({
      deleted: true,
      lockId: 'lock-1',
      userId: 'user-1',
      slot: 27,
      pin: '111111',
      previousPin: '111111',
    })
    expect(context.end).toHaveBeenCalledOnce()
  })
})
