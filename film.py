"""Where every Shot sits on the whole film (0.9.2), shared by the Studio's layout
route and the graph builder.

The film is a row of runs. A run is Shots joined Continuous: H3 Long Shot plans it
with its own planner, so each Shot after the first shares the 22 overlap frames
with the one before (hidden on the film). A Cut or Context join starts a new run:
that Shot shows its whole take, nothing hidden, right where the run before ends.

A Shot's move (Alt + ← / →) belongs to its run: the first Shot of the run carries
it, and the whole run moves.

A Shot with an empty prompt that isn't rendered (0.11.0) is a placeholder: it never
renders and holds its exact length on the film (to the frame, nothing snapped), as a
run of its own.

Positions are in frames at 24 fps. `planner` is H3 Long Shot's planner module."""

FPS = 24


def is_empty(shot):
    """A placeholder: a Shot (not a clip) with an empty prompt and no take in use."""
    if not isinstance(shot, dict) or shot.get("kind") == "clip":
        return False
    if str(shot.get("text") or "").strip():
        return False
    return not (shot.get("status") in ("approved", "review") and shot.get("take"))


def is_cut(shots, i):
    """Does Shot i start a new run (a Cut or Context join, or a clip after a clip)?"""
    if i <= 0:
        return True
    sh, pv = shots[i], shots[i - 1]
    if is_empty(sh) or is_empty(pv):
        return True                                   # a placeholder is a run of its own
    join = sh.get("film_join", sh.get("join"))        # the film's own join, not a render's override
    if join in ("cut", "context"):
        return True
    return sh.get("kind") == "clip" and pv.get("kind") == "clip"


def planned_window(shot):
    """The frames a Shot already has: a clip's, a rendered take's, or a take kept at
    the same length. None: plan it from its seconds."""
    if shot.get("kind") == "clip":
        f = (shot.get("clip") or {}).get("frames")
        return int(f) if f else None
    w = shot.get("window")
    if not w:
        return None
    if shot.get("status") in ("approved", "review") and shot.get("take"):
        return int(w)
    try:
        if float(shot.get("take_seconds")) == float(shot.get("seconds")):
            return int(w)
    except (TypeError, ValueError):
        pass
    return None


def shot_seconds(shot):
    if shot.get("kind") == "clip":
        return (float((shot.get("clip") or {}).get("frames") or 0)) / FPS
    try:
        return float(shot.get("seconds") or 0)
    except (TypeError, ValueError):
        return 0.0


def _plan_run(run, overlap, planner):
    if len(run) == 1 and run[0].get("hold"):
        f = max(1, int(run[0]["hold"]))
        return [(0, 0, f)]                            # a placeholder: its exact frames
    specs = []
    for p in run:
        w = p.get("window")
        w = int(w) if isinstance(w, (int, float)) and planner.is_valid_frame_count(int(w)) else None
        specs.append(planner.PieceSpec(float(p.get("seconds") or 0), w, w is not None))
    try:
        plan = planner.plan_pieces(specs, int(overlap))
        return [(s.window_start, s.window_start if s.index == 1 else s.visible_start, s.window_end)
                for s in plan.segments]
    except ValueError:
        # too short to plan as a run (e.g. a tiny clip): end to end, each whole
        out, at = [], 0
        for sp in specs:
            w = sp.window or max(5, planner.nearest_valid(sp.requested_seconds * FPS))
            out.append((at, at, at + w))
            at += w
        return out


def film_layout(pieces, overlap, planner):
    """pieces: [{id, seconds, window, cut, hold}] in film order (cut: starts a new run;
    hold: a placeholder's exact frames, a run of its own).
    Returns {fps, total, pieces: [{id, ws, vs, we, run}]}: where each window starts,
    the first frame the film shows of it, and where it ends."""
    runs, cur = [], []
    for i, p in enumerate(pieces):
        if i and (p.get("cut") or p.get("hold") or pieces[i - 1].get("hold")):
            runs.append(cur)
            cur = []
        cur.append(p)
    if cur:
        runs.append(cur)
    out, base = [], 0
    for k, run in enumerate(runs):
        spans = _plan_run(run, overlap, planner)
        for p, (ws, vs, we) in zip(run, spans):
            out.append({"id": p.get("id"), "ws": base + ws, "vs": base + vs, "we": base + we, "run": k})
        base += spans[-1][2] if spans else 0
    return {"fps": FPS, "total": base, "pieces": out}


def run_shifts(shots):
    """{id: frames}: each Shot's move, which is its run's (the run's first Shot carries it)."""
    out, shift = {}, 0
    for i, sh in enumerate(shots):
        if is_cut(shots, i):
            try:
                shift = int(((sh.get("place") or {}).get("shift")) or 0)
            except (TypeError, ValueError):
                shift = 0
        out[str(sh.get("id"))] = shift
    return out


def film_pieces(shots, windows=None):
    """Layout pieces for these Shots (film order); `windows` overrides a Shot's frames."""
    windows = windows or {}
    return [{"id": str(sh.get("id")), "seconds": shot_seconds(sh),
             "window": windows.get(str(sh.get("id")), planned_window(sh)), "cut": is_cut(shots, i),
             "hold": hold_frames(sh) if is_empty(sh) else 0}
            for i, sh in enumerate(shots)]


def hold_frames(shot):
    """A placeholder's length in whole frames."""
    return max(1, int(round(shot_seconds(shot) * FPS)))


def render_windows(chain, overlap, planner):
    """{id: frames}: each Shot's window in this render, as Long Shot will plan it
    (locked takes keep theirs; a Shot rendered after another in the chain gets the
    shared zone in front)."""
    specs = []
    for sh in chain:
        if sh.get("kind") == "clip":
            w = planned_window(sh)
            specs.append(planner.PieceSpec(shot_seconds(sh), w, w is not None))
            continue
        w = None
        if sh.get("lock"):
            w = sh.get("window") or sh.get("frames")
        elif sh.get("frames"):
            w = sh.get("frames")
        w = int(w) if isinstance(w, (int, float)) and planner.is_valid_frame_count(int(w)) else None
        specs.append(planner.PieceSpec(shot_seconds(sh), w, bool(sh.get("lock")) and w is not None))
    plan = planner.plan_pieces(specs, int(overlap))
    return {str(sh.get("id")): seg.window_frames for sh, seg in zip(chain, plan.segments)}


def film_shots(project):
    """The Shots on the film: active ones, plus those a render leaves out (they keep
    their time)."""
    return [sh for sh in project.get("shots") or []
            if isinstance(sh, dict) and (not sh.get("bypassed") or sh.get("left_out"))]


def frame0_positions(film_shots, chain, overlap, planner):
    """{id: (frame, window)} for the Shots of this render: where each take's frame 0
    lands on the film (moves included), and its window. Film Shots not in the render
    keep their planned frames."""
    wins = render_windows(chain, overlap, planner)
    lay = film_layout(film_pieces(film_shots, wins), overlap, planner)
    by = {p["id"]: p for p in lay["pieces"]}
    shifts = run_shifts(film_shots)
    out = {}
    for sh in chain:
        sid = str(sh.get("id"))
        if sid in by:
            out[sid] = (by[sid]["ws"] + shifts.get(sid, 0), wins[sid])
    return out
