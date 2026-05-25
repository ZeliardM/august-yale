/* Copyright(C) 2024, homebridge-plugins (https://github.com/homebridge-plugins). All rights reserved.
 *
 * pins.ts: August-Yale API pin-related endpoints.
 */

import { PinOperationError } from '../exceptions.js'

type CredentialAction = 'intent' | 'commit'
type CredentialState = 'load' | 'update' | 'delete'
const DEFAULT_ACCESS_CODE_FIRST_NAME = 'AccessCode'
const DEFAULT_ACCESS_CODE_LAST_NAME_PREFIX = 'User'
type PinOperationName = 'addPin' | 'addPins' | 'modifyPin' | 'deletePin'
const PIN_STATE_KEYS = ['loaded', 'created', 'disabled', 'disabling', 'enabling', 'deleting', 'updating'] as const

export interface AddPinOptions {
  credentialType?: string
  firstName?: string
  lastName?: string
  phone?: string
  userApiType?: number
}

export interface AugustPin {
  accessType?: string
  firstName?: string
  lastName?: string
  name?: string
  pin: string
  raw: any
  slot: number
  state?: string
  userId: string
}

export interface PinOperationResult {
  commitCredential?: any
  createdUser?: AugustUnverifiedUserResponse
  deleted?: boolean
  generatedPin?: string
  loadCredential?: any
  loadSync?: any
  lockId: string
  pin: string
  pinRecord?: AugustPin
  previousPin?: string
  rollback?: PinRollbackResult
  slot: number
  sync?: any
  updateCredential?: any
  userId: string
}

export interface PinRollbackResult {
  commitCredential?: any
  deleteCredential?: any
  sync?: any
}

interface UpdatePinRecordOptions {
  commit: 'always' | 'if-needed'
}

export interface AugustUnverifiedUserResponse {
  firstName?: string
  id: string
  lastName?: string
  phone?: string
  pin: string
  slot: number
}

interface CredentialStateOptions {
  accessType?: string
  action: CredentialAction
  pin?: string
  state: CredentialState
  userApiType?: number
  slot: number
}

/**
 * Get lock pins
 * @param keepSession - Whether to keep the session alive after this call
 * @param lockId - Lock ID to get pins for
 * @returns Lock pins data
 */
async function pins(this: any, keepSession: boolean, lockId: string): Promise<any> {
  try {
    const response = await this.get(`/locks/${lockId}/pins`)
    // Return the loaded pins if available, otherwise return full response
    return response?.body?.loaded || response?.body
  } finally {
    if (!keepSession) {
      this.end()
    }
  }
}

export async function pinStates(this: any, keepSession: boolean, lockId: string): Promise<any> {
  try {
    const response = await this.get(`/locks/${lockId}/pins`)
    return response?.body
  } finally {
    if (!keepSession) {
      this.end()
    }
  }
}

/**
 * Add an August/Yale keypad PIN, then update the generated August PIN to the
 * requested PIN once the credential has been loaded to the lock.
 *
 * @param keepSession - Whether to keep the session alive after this call
 * @param lockId - Lock ID to add a PIN for
 * @param pin - PIN/code to add
 * @param options - Optional unverified-user naming and credential settings
 * @returns PIN operation details
 */
export async function addPin(
  this: any,
  keepSession: boolean,
  lockId: string,
  pin: string,
  options: AddPinOptions = {},
): Promise<PinOperationResult> {
  assertPin(pin, 'pin')

  try {
    await pinOperationStep('addPin', 'preflight-pin-state', lockId, async () => {
      const existing = await findAnyPinRecord.call(this, lockId, pin)
      if (existing) {
        throw new Error(`PIN already exists on lock ${lockId} in ${existing.state ?? 'unknown'} state`)
      }
    })

    const userName = await pinOperationStep('addPin', 'choose-user-name', lockId, () => resolveAddPinUserName.call(this, lockId, options))
    const createdUser = await pinOperationStep('addPin', 'create-user', lockId, () => createUnverifiedPinUser.call(this, lockId, userName, options))
    const loadCredential = await pinOperationStep('addPin', 'load-credential', lockId, () => writeCredentialState.call(this, lockId, createdUser.id, {
      action: 'intent',
      state: 'load',
      pin: createdUser.pin,
      slot: createdUser.slot,
      accessType: 'always',
      userApiType: options.userApiType ?? 1,
    }))
    const loadSync = await pinOperationStep('addPin', 'sync-pins', lockId, () => syncPins.call(this, lockId))

    if (createdUser.pin === pin) {
      const pinRecord = await pinOperationStep('addPin', 'verify-pin', lockId, () => findPinRecord.call(this, lockId, pin))
      return {
        createdUser,
        generatedPin: createdUser.pin,
        loadCredential,
        loadSync,
        lockId,
        pin,
        pinRecord,
        slot: createdUser.slot,
        sync: loadSync,
        userId: createdUser.id,
      }
    }

    let updateResult: PinOperationResult
    try {
      updateResult = await updatePinRecord.call(this, 'addPin', lockId, {
        pin: createdUser.pin,
        raw: createdUser,
        slot: createdUser.slot,
        state: 'loaded',
        userId: createdUser.id,
      }, pin, { commit: 'if-needed' })
    } catch (error) {
      const wrapped = error instanceof PinOperationError
        ? error
        : wrapPinOperationError('addPin', 'update-requested-pin', lockId, error)

      if (wrapped.step === 'update-credential-intent') {
        await attachAddPinRollback.call(this, wrapped, lockId, createdUser)
      }

      throw wrapped
    }

    return {
      ...updateResult,
      createdUser,
      generatedPin: createdUser.pin,
      loadCredential,
      loadSync,
      sync: updateResult.sync,
    }
  } finally {
    if (!keepSession) {
      this.end()
    }
  }
}

/**
 * Add multiple August/Yale keypad PINs with shared sync rounds.
 *
 * HomeKit can send several access codes in a single AccessCodeControlPoint
 * write. Adding each one through addPin() serially is correct but too slow for
 * Home's control-point timeout. This batches the app-style flow:
 * create users, load generated credentials, sync once, update to requested
 * PINs, sync once, then verify all requested PINs.
 *
 * @param keepSession - Whether to keep the session alive after this call
 * @param lockId - Lock ID to add PINs for
 * @param pinsToAdd - PINs/codes to add
 * @param options - Optional unverified-user naming and credential settings
 * @returns Per-PIN operation details in input order
 */
export async function addPins(
  this: any,
  keepSession: boolean,
  lockId: string,
  pinsToAdd: string[],
  options: AddPinOptions = {},
): Promise<PinOperationResult[]> {
  const pins = pinsToAdd.map(pin => String(pin))
  const createdUsers: AugustUnverifiedUserResponse[] = []

  try {
    assertUniquePins(pins)
    for (const pin of pins) {
      assertPin(pin, 'pin')
    }

    if (pins.length === 0) {
      return []
    }

    if (pins.length === 1) {
      return [await addPin.call(this, true, lockId, pins[0]!, options)]
    }

    const existingPins = await pinOperationStep('addPins', 'preflight-pin-state', lockId, async () => {
      const records = await getAllPinRecords.call(this, lockId)
      const existing = pins
        .map(pin => records.find(record => record.pin === pin))
        .filter((record): record is AugustPin => Boolean(record))

      if (existing.length > 0) {
        const summary = existing
          .map(record => `${record.pin}:${record.state ?? 'unknown'}`)
          .join(', ')
        throw new Error(`PIN already exists on lock ${lockId}: ${summary}`)
      }

      return records
    })

    const userNames = resolveAddPinUserNames(existingPins, options, pins.length)
    for (const index of pins.keys()) {
      const userName = userNames[index]
      if (!userName) {
        throw new Error(`Missing generated user name for PIN index ${index}`)
      }

      const createdUser = await pinOperationStep('addPins', `create-user-${index + 1}`, lockId, () => createUnverifiedPinUser.call(this, lockId, userName, options))
      createdUsers.push(createdUser)
    }

    const loadCredentials: any[] = []
    for (const createdUser of createdUsers) {
      loadCredentials.push(await pinOperationStep('addPins', 'load-credential', lockId, () => writeCredentialState.call(this, lockId, createdUser.id, {
        action: 'intent',
        state: 'load',
        pin: createdUser.pin,
        slot: createdUser.slot,
        accessType: 'always',
        userApiType: options.userApiType ?? 1,
      })))
    }

    const loadSync = await pinOperationStep('addPins', 'sync-load-pins', lockId, () => syncPins.call(this, lockId))
    await pinOperationStep('addPins', 'verify-generated-pins-loaded', lockId, () => findPinRecordsWithRetry.call(this, lockId, createdUsers.map(user => user.pin)))

    const updateCredentials: any[] = []
    const updateIndexes: number[] = []
    for (const [index, createdUser] of createdUsers.entries()) {
      const requestedPin = pins[index]
      if (createdUser.pin === requestedPin) {
        updateCredentials[index] = undefined
        continue
      }

      updateIndexes.push(index)
      updateCredentials[index] = await pinOperationStep('addPins', 'update-credential-intent', lockId, () => writeCredentialState.call(this, lockId, createdUser.id, {
        action: 'intent',
        state: 'update',
        pin: requestedPin,
        slot: createdUser.slot,
        accessType: 'always',
      }))
    }

    const updateSync = updateIndexes.length > 0
      ? await pinOperationStep('addPins', 'sync-update-pins', lockId, () => syncPins.call(this, lockId))
      : loadSync

    let loadedPins = await findPinRecordsWithRetry.call(this, lockId, pins)
    let missingPins = pins.filter(pin => !loadedPins.some(record => record.pin === pin))
    const commitCredentials: any[] = []

    for (const missingPin of missingPins) {
      const index = pins.indexOf(missingPin)
      const createdUser = createdUsers[index]
      if (!createdUser) {
        continue
      }

      try {
        commitCredentials[index] = await writeCredentialState.call(this, lockId, createdUser.id, {
          action: 'commit',
          state: 'update',
          pin: missingPin,
          slot: createdUser.slot,
          accessType: 'always',
        })
      } catch (error) {
        if (!isInvalidCredentialTransition(error)) {
          throw wrapPinOperationError('addPins', 'update-credential-commit', lockId, error)
        }
      }
    }

    if (missingPins.length > 0) {
      loadedPins = await pinOperationStep('addPins', 'verify-pins', lockId, () => findPinRecordsWithRetry.call(this, lockId, pins))
      missingPins = pins.filter(pin => !loadedPins.some(record => record.pin === pin))
      if (missingPins.length > 0) {
        throw new Error(`PINs were not loaded on lock ${lockId}: ${missingPins.join(', ')}`)
      }
    }

    return pins.map((pin, index) => {
      const createdUser = createdUsers[index]!
      const pinRecord = loadedPins.find(record => record.pin === pin)

      if (!pinRecord) {
        throw new Error(`PIN ${pin} was not found on lock ${lockId}`)
      }

      return {
        commitCredential: commitCredentials[index],
        createdUser,
        generatedPin: createdUser.pin,
        loadCredential: loadCredentials[index],
        loadSync,
        lockId,
        pin,
        pinRecord,
        previousPin: createdUser.pin,
        slot: pinRecord.slot,
        sync: updateSync,
        updateCredential: updateCredentials[index],
        userId: pinRecord.userId,
      }
    })
  } catch (error) {
    const wrapped = error instanceof PinOperationError
      ? error
      : wrapPinOperationError('addPins', 'batch-add', lockId, error)

    if (createdUsers.length > 0 && !wrapped.rollback) {
      wrapped.rollback = await rollbackCreatedPinsSafely.call(this, lockId, createdUsers)
    }

    throw wrapped
  } finally {
    if (!keepSession) {
      this.end()
    }
  }
}

/**
 * Modify an August/Yale keypad PIN by looking up the existing PIN record, then
 * applying the app-style intent/sync/commit credential flow.
 *
 * @param keepSession - Whether to keep the session alive after this call
 * @param lockId - Lock ID to modify a PIN for
 * @param oldPin - Existing PIN/code to replace
 * @param newPin - Replacement PIN/code
 * @returns PIN operation details
 */
export async function modifyPin(this: any, keepSession: boolean, lockId: string, oldPin: string, newPin: string): Promise<PinOperationResult> {
  assertPin(oldPin, 'oldPin')
  assertPin(newPin, 'newPin')

  try {
    const pinRecord = await pinOperationStep('modifyPin', 'find-existing-pin', lockId, () => findPinRecord.call(this, lockId, oldPin))
    const result = await updatePinRecord.call(this, 'modifyPin', lockId, pinRecord, newPin, { commit: 'always' })
    return result
  } finally {
    if (!keepSession) {
      this.end()
    }
  }
}

/**
 * Delete an August/Yale keypad PIN by looking up the existing PIN record, then
 * applying the app-style intent/sync/commit credential flow.
 *
 * @param keepSession - Whether to keep the session alive after this call
 * @param lockId - Lock ID to delete a PIN from
 * @param pin - Existing PIN/code to delete
 * @returns PIN operation details
 */
export async function deletePin(this: any, keepSession: boolean, lockId: string, pin: string): Promise<PinOperationResult> {
  assertPin(pin, 'pin')

  try {
    const pinRecord = await pinOperationStep('deletePin', 'find-existing-pin', lockId, () => findPinRecord.call(this, lockId, pin))
    const updateCredential = await pinOperationStep('deletePin', 'delete-credential-intent', lockId, () => writeCredentialState.call(this, lockId, pinRecord.userId, {
      action: 'intent',
      state: 'delete',
      pin: pinRecord.pin,
      slot: pinRecord.slot,
    }))
    const sync = await pinOperationStep('deletePin', 'sync-pins', lockId, () => syncPins.call(this, lockId))
    const commitCredential = await pinOperationStep('deletePin', 'delete-credential-commit', lockId, () => writeCredentialState.call(this, lockId, pinRecord.userId, {
      action: 'commit',
      state: 'delete',
      pin: pinRecord.pin,
      slot: pinRecord.slot,
    }))

    await pinOperationStep('deletePin', 'verify-delete', lockId, async () => {
      const remaining = await getPins.call(this, lockId)
      if (remaining.some(record => record.pin === pin)) {
        throw new Error(`PIN was not deleted from lock ${lockId}`)
      }
    })

    return {
      commitCredential,
      deleted: true,
      lockId,
      pin,
      pinRecord,
      previousPin: pin,
      slot: pinRecord.slot,
      sync,
      updateCredential,
      userId: pinRecord.userId,
    }
  } finally {
    if (!keepSession) {
      this.end()
    }
  }
}

async function resolveAddPinUserName(this: any, lockId: string, options: AddPinOptions): Promise<{ firstName: string, lastName: string }> {
  const firstName = options.firstName ?? DEFAULT_ACCESS_CODE_FIRST_NAME
  if (options.lastName) {
    return {
      firstName,
      lastName: options.lastName,
    }
  }

  const existingPins = await getAllPinRecords.call(this, lockId)
  const nextUserNumber = nextAccessCodeUserNumbers(existingPins, firstName, 1)[0] ?? 1

  return {
    firstName,
    lastName: `${DEFAULT_ACCESS_CODE_LAST_NAME_PREFIX}${nextUserNumber}`,
  }
}

function resolveAddPinUserNames(existingPins: AugustPin[], options: AddPinOptions, count: number): Array<{ firstName: string, lastName: string }> {
  const firstName = options.firstName ?? DEFAULT_ACCESS_CODE_FIRST_NAME
  if (options.lastName && count === 1) {
    return [{
      firstName,
      lastName: options.lastName,
    }]
  }

  const nextUserNumbers = nextAccessCodeUserNumbers(existingPins, firstName, count)
  return nextUserNumbers.map(userNumber => ({
    firstName,
    lastName: `${DEFAULT_ACCESS_CODE_LAST_NAME_PREFIX}${userNumber}`,
  }))
}

async function createUnverifiedPinUser(
  this: any,
  lockId: string,
  userName: { firstName: string, lastName: string },
  options: AddPinOptions,
): Promise<AugustUnverifiedUserResponse> {
  const body = omitUndefined({
    deviceID: lockId,
    deviceType: 'lock',
    firstName: userName.firstName,
    lastName: userName.lastName,
    phone: options.phone,
    credentialType: options.credentialType ?? 'pin',
    userApiType: options.userApiType ?? 1,
  })

  const response = await this.post('/unverifiedusers', body, '2.0.0')
  const createdUser = response?.body as AugustUnverifiedUserResponse | undefined

  if (!createdUser?.id || createdUser.slot === undefined || !createdUser.pin) {
    throw new Error('August did not return a complete unverified PIN user response')
  }

  return createdUser
}

async function updatePinRecord(
  this: any,
  operation: PinOperationName,
  lockId: string,
  pinRecord: AugustPin,
  newPin: string,
  options: UpdatePinRecordOptions,
): Promise<PinOperationResult> {
  const updateCredential = await pinOperationStep(operation, 'update-credential-intent', lockId, () => writeCredentialState.call(this, lockId, pinRecord.userId, {
    action: 'intent',
    state: 'update',
    pin: newPin,
    slot: pinRecord.slot,
    accessType: pinRecord.accessType ?? 'always',
  }))
  const sync = await pinOperationStep(operation, 'sync-pins', lockId, () => syncPins.call(this, lockId))

  if (options.commit === 'if-needed') {
    try {
      const updatedRecord = await findPinRecord.call(this, lockId, newPin)

      return {
        lockId,
        pin: newPin,
        pinRecord: updatedRecord,
        previousPin: pinRecord.pin,
        slot: pinRecord.slot,
        sync,
        updateCredential,
        userId: pinRecord.userId,
      }
    } catch {
      // Some update paths remain in an intermediate state until the app-style
      // commit call. If verification fails after sync, fall through to commit.
    }
  }

  let commitCredential: any
  let updatedRecord: AugustPin

  try {
    commitCredential = await writeCredentialState.call(this, lockId, pinRecord.userId, {
      action: 'commit',
      state: 'update',
      pin: newPin,
      slot: pinRecord.slot,
      accessType: pinRecord.accessType ?? 'always',
    })
    updatedRecord = await pinOperationStep(operation, 'verify-pin', lockId, () => findPinRecordWithRetry.call(this, lockId, newPin))
  } catch (error) {
    if (!isInvalidCredentialTransition(error)) {
      throw wrapPinOperationError(operation, 'update-credential-commit', lockId, error)
    }

    // August can report that commit/update is no longer a valid transition
    // when the preceding sync already loaded the requested PIN.
    updatedRecord = await pinOperationStep(operation, 'verify-pin', lockId, () => findPinRecordWithRetry.call(this, lockId, newPin))
  }

  return {
    commitCredential,
    lockId,
    pin: newPin,
    pinRecord: updatedRecord,
    previousPin: pinRecord.pin,
    slot: pinRecord.slot,
    sync,
    updateCredential,
    userId: pinRecord.userId,
  }
}

async function writeCredentialState(this: any, lockId: string, userId: string, options: CredentialStateOptions): Promise<any> {
  const body = omitUndefined({
    type: 'pin',
    state: options.state,
    action: options.action,
    pin: options.pin,
    slot: String(options.slot),
    accessType: options.accessType,
    userApiType: options.userApiType,
  })

  const encodedUserId = encodeURIComponent(userId)
  const response = await this.put(`/locks/${lockId}/users/${encodedUserId}/credentials`, body)
  return response?.body
}

async function syncPins(this: any, lockId: string): Promise<any> {
  const response = await this.put(`/locks/${lockId}/pins/sync`, null)
  return response?.body
}

async function getPins(this: any, lockId: string): Promise<AugustPin[]> {
  const response = await this.get(`/locks/${lockId}/pins`)
  const records = getLoadedRecords(response?.body)

  return records
    .map(record => normalizePinRecord(record, 'loaded'))
    .filter((record): record is AugustPin => Boolean(record))
}

async function getAllPinRecords(this: any, lockId: string): Promise<AugustPin[]> {
  const response = await this.get(`/locks/${lockId}/pins`)
  const records = getRecordsForAllStates(response?.body)

  return records
    .map(({ record, state }) => normalizePinRecord(record, state))
    .filter((record): record is AugustPin => Boolean(record))
}

async function findPinRecord(this: any, lockId: string, pin: string): Promise<AugustPin> {
  const pins = await getPins.call(this, lockId)
  const pinRecord = pins.find(record => record.pin === pin)

  if (!pinRecord) {
    throw new Error(`PIN ${pin} was not found on lock ${lockId}`)
  }

  return pinRecord
}

async function findAnyPinRecord(this: any, lockId: string, pin: string): Promise<AugustPin | undefined> {
  const pins = await getAllPinRecords.call(this, lockId)
  return pins.find(record => record.pin === pin)
}

async function attachAddPinRollback(this: any, error: PinOperationError, lockId: string, createdUser: AugustUnverifiedUserResponse): Promise<void> {
  try {
    error.rollback = await rollbackCreatedPin.call(this, lockId, createdUser)
  } catch (rollbackError) {
    error.rollback = {
      error: serializeRollbackError(rollbackError),
    }
  }
}

async function rollbackCreatedPinsSafely(this: any, lockId: string, createdUsers: AugustUnverifiedUserResponse[]): Promise<any[]> {
  const results: any[] = []

  for (const createdUser of createdUsers) {
    try {
      results.push(await rollbackCreatedPin.call(this, lockId, createdUser))
    } catch (rollbackError) {
      results.push({ error: serializeRollbackError(rollbackError), userId: createdUser.id })
    }
  }

  return results
}

async function rollbackCreatedPin(this: any, lockId: string, createdUser: AugustUnverifiedUserResponse): Promise<PinRollbackResult> {
  const currentRecord = await getAllPinRecords.call(this, lockId)
    .then(records => records.find(record => record.userId === createdUser.id))
    .catch(() => undefined)
  const pin = currentRecord?.pin ?? createdUser.pin
  const slot = currentRecord?.slot ?? createdUser.slot
  const deleteCredential = await writeCredentialState.call(this, lockId, createdUser.id, {
    action: 'intent',
    state: 'delete',
    pin,
    slot,
  })
  const sync = await syncPins.call(this, lockId)
  let commitCredential: any

  try {
    commitCredential = await writeCredentialState.call(this, lockId, createdUser.id, {
      action: 'commit',
      state: 'delete',
      pin,
      slot,
    })
  } catch (error) {
    if (!isInvalidCredentialTransition(error)) {
      throw error
    }
  }

  return {
    commitCredential,
    deleteCredential,
    sync,
  }
}

async function pinOperationStep<T>(
  operation: PinOperationName,
  step: string,
  lockId: string,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action()
  } catch (error) {
    throw wrapPinOperationError(operation, step, lockId, error)
  }
}

function wrapPinOperationError(operation: PinOperationName, step: string, lockId: string, error: unknown): PinOperationError {
  if (error instanceof PinOperationError) {
    return error
  }

  return new PinOperationError(operation, step, lockId, error instanceof Error ? error : new Error(String(error)))
}

function nextAccessCodeUserNumbers(pins: AugustPin[], firstName: string, count: number): number[] {
  const lastNamePattern = new RegExp(`^${DEFAULT_ACCESS_CODE_LAST_NAME_PREFIX}(\\d+)$`, 'i')
  const existingNumbers = pins
    .filter(pin => pin.firstName?.toLowerCase() === firstName.toLowerCase())
    .map((pin) => {
      const match = pin.lastName?.match(lastNamePattern)
      return match ? Number(match[1]) : 0
    })
    .filter(number => Number.isFinite(number) && number > 0)
  const occupied = new Set(existingNumbers)
  const availableNumbers: number[] = []
  let candidate = 1

  while (availableNumbers.length < count) {
    if (!occupied.has(candidate)) {
      availableNumbers.push(candidate)
      occupied.add(candidate)
    }
    candidate += 1
  }

  return availableNumbers
}

async function findPinRecordWithRetry(this: any, lockId: string, pin: string): Promise<AugustPin> {
  let lastError: unknown

  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      return await findPinRecord.call(this, lockId, pin)
    } catch (error) {
      lastError = error

      if (attempt < 9) {
        await sleep(1000)
      }
    }
  }

  throw lastError
}

async function findPinRecordsWithRetry(this: any, lockId: string, pins: string[]): Promise<AugustPin[]> {
  let lastError: unknown

  for (let attempt = 0; attempt < 10; attempt++) {
    const records = await getPins.call(this, lockId)
    const missingPins = pins.filter(pin => !records.some(record => record.pin === pin))
    if (missingPins.length === 0) {
      return records
    }

    lastError = new Error(`PINs were not found on lock ${lockId}: ${missingPins.join(', ')}`)

    if (attempt < 9) {
      await sleep(1000)
    }
  }

  throw lastError
}

function getLoadedRecords(body: any): any[] {
  if (Array.isArray(body?.loaded)) {
    return body.loaded
  }

  if (Array.isArray(body)) {
    return body
  }

  if (body) {
    return [body]
  }

  return []
}

function getRecordsForAllStates(body: any): Array<{ record: any, state: string }> {
  const records: Array<{ record: any, state: string }> = []

  if (body && typeof body === 'object' && !Array.isArray(body)) {
    for (const state of PIN_STATE_KEYS) {
      const stateRecords = body[state]
      if (Array.isArray(stateRecords)) {
        records.push(...stateRecords.map(record => ({ record, state })))
      }
    }

    if (records.length > 0) {
      return records
    }
  }

  if (Array.isArray(body)) {
    return body.map(record => ({ record, state: firstString(record, ['state', 'State']) ?? 'loaded' }))
  }

  if (body) {
    return [{ record: body, state: firstString(body, ['state', 'State']) ?? 'loaded' }]
  }

  return records
}

function normalizePinRecord(record: any, fallbackState?: string): AugustPin | undefined {
  const pin = firstString(record, ['pin', 'Pin', 'PIN'])
  const userId = firstString(record, ['userID', 'userId', 'UserID', 'UserId', 'id'])
  const slotValue = firstValue(record, ['slot', 'Slot'])
  const slot = Number(slotValue)

  if (!pin || !userId || !Number.isFinite(slot)) {
    return undefined
  }

  const firstName = firstString(record, ['firstName', 'FirstName'])
  const lastName = firstString(record, ['lastName', 'LastName'])
  const name = [firstName, lastName].filter(Boolean).join(' ').trim() || undefined

  return {
    accessType: firstString(record, ['accessType', 'AccessType']),
    firstName,
    lastName,
    name,
    pin,
    raw: record,
    slot,
    state: firstString(record, ['state', 'State']) ?? fallbackState,
    userId,
  }
}

function firstValue(record: any, keys: string[]): any {
  for (const key of keys) {
    if (record?.[key] !== undefined && record?.[key] !== null) {
      return record[key]
    }
  }

  return undefined
}

function firstString(record: any, keys: string[]): string | undefined {
  const value = firstValue(record, keys)
  if (value === undefined || value === null) {
    return undefined
  }

  return String(value)
}

function omitUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, fieldValue]) => fieldValue !== undefined && fieldValue !== null),
  ) as Partial<T>
}

function isInvalidCredentialTransition(error: unknown): boolean {
  const candidate = error as { body?: { message?: string }, message?: string, statusCode?: number | string }
  const message = [candidate?.message, candidate?.body?.message]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  return Number(candidate?.statusCode) === 409 && message.includes('cannot transition')
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, milliseconds))
}

function serializeRollbackError(error: unknown): Record<string, unknown> {
  const candidate = error as { body?: unknown, message?: string, name?: string, statusCode?: number | string }
  return omitUndefined({
    body: candidate?.body,
    message: candidate?.message ?? String(error),
    name: candidate?.name,
    statusCode: candidate?.statusCode === undefined ? undefined : Number(candidate.statusCode),
  })
}

function assertPin(pin: string, name: string): void {
  if (typeof pin !== 'string' || pin.trim().length === 0) {
    throw new Error(`${name} is required`)
  }
}

function assertUniquePins(pins: string[]): void {
  const seen = new Set<string>()
  for (const pin of pins) {
    if (seen.has(pin)) {
      throw new Error(`Duplicate PIN in addPins request: ${pin}`)
    }
    seen.add(pin)
  }
}

export default pins
