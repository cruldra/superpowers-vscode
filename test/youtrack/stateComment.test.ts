import { describe, expect, it } from 'vitest'
import { findLatestState, parseStateComment, STATE_MARKER } from '../../src/youtrack/stateComment'

describe('youtrack stateComment parsing', () => {
  it('parses a marker-prefixed state blob', () => {
    const body = `${STATE_MARKER}\n${JSON.stringify({ column: 'in-progress', sessionId: 'abc' })}`
    expect(parseStateComment(body)).toEqual({ column: 'in-progress', sessionId: 'abc' })
  })

  it('tolerates a bare JSON blob written without the marker', () => {
    expect(parseStateComment(JSON.stringify({ column: 'done' }))).toEqual({ column: 'done' })
  })

  it('rejects JSON objects without any known state field (customer replies)', () => {
    expect(parseStateComment(JSON.stringify({ hello: 'world' }))).toBeNull()
    expect(parseStateComment('just a plain comment')).toBeNull()
    expect(parseStateComment('')).toBeNull()
  })

  it('returns the latest state comment, skipping trailing non-state comments', () => {
    const comments = [
      { id: '1', text: `${STATE_MARKER}\n${JSON.stringify({ column: 'todo' })}` },
      { id: '2', text: `${STATE_MARKER}\n${JSON.stringify({ column: 'in-progress', branch: 'feat/x' })}` },
      { id: '3', text: '客户后续补充：还是不行' },
    ]
    expect(findLatestState(comments)).toEqual({ column: 'in-progress', branch: 'feat/x' })
  })

  it('returns null when no state comment exists', () => {
    expect(findLatestState([{ id: '1', text: 'hi' }, { id: '2', text: 'thanks' }])).toBeNull()
  })
})
