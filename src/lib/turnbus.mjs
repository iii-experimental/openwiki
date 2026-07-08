// Real-time collection of harness turns via `harness::turn-completed` events,
// replacing per-turn `harness::status` polling. openwiki registers ONE trigger
// on the harness's emitted turn-completed type (see index.mjs) and routes each
// event here. A generation registers its root session; the router delivers the
// plan turn (matched by session_id == root) and each page child (matched by
// event.parent_session_id == root, which only harness::spawn stamps — a plain
// send leaves it null, harness send.rs sets display_parent_session_id: None).
//
// One in-process map keyed by root session id. Single-process worker; if
// openwiki ever runs multiple instances, the subscription is per-engine so each
// instance sees every event and ignores roots it does not own (cheap map miss).

const active = new Map(); // root session id -> collector

// Register a collector for one generation. Returns an unregister handle.
//   onPlan(result)            called once when the root/plan turn completes
//   onPage(childId, result)   called per page child completion (ok)
//   onPageError(childId, err) called per page child that failed/cancelled
export function register(rootSessionId, { onPlan, onPage, onPageError } = {}) {
  active.set(rootSessionId, { onPlan, onPage, onPageError });
  return () => active.delete(rootSessionId);
}

export function unregister(rootSessionId) { active.delete(rootSessionId); }

export function isActive(rootSessionId) { return active.has(rootSessionId); }

// Route one harness::turn-completed event payload to its generation, if any.
// Event shape (harness events.rs): { session_id, turn_id, status, result?,
// result_error?, parent_session_id? }. Returns true when it matched a root.
export function deliver(evt) {
  if (!evt || typeof evt !== 'object') return false;
  const sid = evt.session_id;
  const pid = evt.parent_session_id;
  // Page child: parent_session_id points at a root we own.
  if (pid && active.has(pid)) {
    const c = active.get(pid);
    if (evt.status === 'completed') { try { c.onPage?.(sid, evt.result); } catch { /* isolate */ } }
    else { try { c.onPageError?.(sid, evt.result_error || evt.status); } catch { /* isolate */ } }
    return true;
  }
  // Plan/root turn: the root session itself completed.
  if (sid && active.has(sid)) {
    const c = active.get(sid);
    if (evt.status === 'completed') { try { c.onPlan?.(evt.result); } catch { /* isolate */ } }
    else { try { c.onPageError?.(sid, evt.result_error || evt.status); } catch { /* isolate */ } }
    return true;
  }
  return false;
}
