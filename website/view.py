from flask import Blueprint, render_template, request, flash, jsonify
from flask_login import login_required, current_user
from .models import Note, PomodoroSession
from . import db
import json
from datetime import datetime, timezone, timedelta

POMODORO_SECONDS = 25 * 60

view = Blueprint('view', __name__)


@view.route('/', methods=['GET', 'POST'])
@login_required
def home():
    if request.method == 'POST': 
        note = request.form.get('note')  # Gets the note from the HTML
        pomo_min = request.form.get('pomodoro_minutes', type=int)
        finish_by_str = request.form.get('finish_by')  # 'YYYY-MM-DDTHH:MM'

        if not note or len(note) < 1:
            flash('Note is too short!', category='error')
        else:
            seconds = None
            if isinstance(pomo_min, int) and pomo_min > 0 and pomo_min <= 300:
                seconds = pomo_min * 60
            new_note = Note(data=note, user_id=current_user.id)
            # If Finish by is provided, prefer it over minutes
            if isinstance(finish_by_str, str) and finish_by_str:
                try:
                    # datetime-local comes without timezone; treat as UTC for simplicity
                    dt = datetime.strptime(finish_by_str, '%Y-%m-%dT%H:%M').replace(tzinfo=timezone.utc)
                    new_note.finish_by = dt
                except Exception:
                    pass
            if seconds and not new_note.finish_by:
                new_note.pomodoro_seconds = seconds
            db.session.add(new_note)
            db.session.commit()
            flash('Note added!', category='success')

    # Build filters for GET requests (status + date range)
    status_filter = request.args.get('status', type=str)
    from_str = request.args.get('from', type=str)
    to_str = request.args.get('to', type=str)

    query = Note.query.filter_by(user_id=current_user.id)

    allowed = {'planned','in_progress','completed','canceled'}
    if status_filter in allowed:
        query = query.filter(Note.status == status_filter)
    else:
        # Ignore invalid status values so All shows by default
        status_filter = None

    # Date range (inclusive)
    # Note: using the existing Note.date column
    try:
        if from_str:
            from_dt = datetime.strptime(from_str, '%Y-%m-%d')
            query = query.filter(Note.date >= from_dt)
    except Exception:
        from_str = None
    try:
        if to_str:
            to_dt = datetime.strptime(to_str, '%Y-%m-%d') + timedelta(days=1)
            query = query.filter(Note.date < to_dt)
    except Exception:
        to_str = None

    notes = query.all()

    return render_template(
        "home.html",
        user=current_user,
        notes=notes,
        status_filter=status_filter,
        from_date=from_str,
        to_date=to_str,
    )


@view.route('/delete-note', methods=['POST'])
@login_required
def delete_note():  
    payload = json.loads(request.data)
    noteId = payload.get('noteId')
    note = Note.query.get(noteId)
    if note and note.user_id == current_user.id:
        db.session.delete(note)
        db.session.commit()
    return jsonify({})


@view.route('/update-note', methods=['POST'])
@login_required
def update_note():
    payload = json.loads(request.data)
    noteId = payload.get('noteId')
    data = payload.get('data')
    pomo_seconds = payload.get('pomodoroSeconds')
    note = Note.query.get(noteId)
    if not note or note.user_id != current_user.id:
        return jsonify({'ok': False}), 403

    updated = False
    if isinstance(data, str) and len(data.strip()) >= 1:
        note.data = data.strip()
        updated = True
    if isinstance(pomo_seconds, int) and pomo_seconds > 0 and pomo_seconds <= 18000:
        note.pomodoro_seconds = pomo_seconds
        updated = True

    if updated:
        db.session.commit()
        return jsonify({'ok': True})
    return jsonify({'ok': False, 'error': 'invalid payload'}), 400


@view.route('/update-status', methods=['POST'])
@login_required
def update_status():
    payload = json.loads(request.data)
    noteId = payload.get('noteId')
    status = payload.get('status')
    allowed = {'planned','in_progress','completed','canceled'}
    if status not in allowed:
        return jsonify({'ok': False, 'error': 'invalid status'}), 400
    note = Note.query.get(noteId)
    if not note or note.user_id != current_user.id:
        return jsonify({'ok': False}), 403
    note.status = status
    db.session.commit()
    return jsonify({'ok': True})


@view.route('/pomodoro/start', methods=['POST'])
@login_required
def start_pomodoro():
    payload = json.loads(request.data)
    noteId = payload.get('noteId')
    duration_seconds = payload.get('durationSeconds')  # optional override
    target_end_at_str = payload.get('targetEndAt')  # optional absolute end time (ISO)
    note = Note.query.get(noteId)
    if not note or note.user_id != current_user.id:
        return jsonify({'ok': False}), 403

    # If a running session exists for this user/note, return it
    existing = PomodoroSession.query.filter_by(note_id=note.id, user_id=current_user.id, status='running').first()

    now = datetime.now(timezone.utc)
    if existing:
        # If paused, resume based on remaining_seconds
        if existing.is_paused and isinstance(existing.remaining_seconds, int) and existing.remaining_seconds > 0:
            existing.is_paused = False
            existing.started_at = now
            existing.target_end_at = now + timedelta(seconds=int(existing.remaining_seconds))
            existing.paused_at = None
            db.session.commit()
        # Use existing target_end_at if available, else recompute from started_at and note duration
        target = existing.target_end_at or (existing.started_at + timedelta(seconds=(note.pomodoro_seconds or POMODORO_SECONDS)))
        duration = int((target - now).total_seconds()) if target else (note.pomodoro_seconds or POMODORO_SECONDS)
    else:
        # Create new running session
        started = now
        existing = PomodoroSession(note_id=note.id, user_id=current_user.id, started_at=started, status='running')
        # Determine target end
        target = None
        if isinstance(duration_seconds, int) and duration_seconds > 0:
            target = started + timedelta(seconds=duration_seconds)
        elif isinstance(target_end_at_str, str):
            try:
                # Parse ISO (assumed UTC or with offset)
                target = datetime.fromisoformat(target_end_at_str.replace('Z', '+00:00'))
            except Exception:
                target = None
        if target is None:
            # Fallback to note's default duration
            duration_seconds = (note.pomodoro_seconds or POMODORO_SECONDS)
            target = started + timedelta(seconds=duration_seconds)
        existing.target_end_at = target
        db.session.add(existing)
        db.session.commit()
        duration = int((target - now).total_seconds())

    return jsonify({'ok': True, 'sessionId': existing.id, 'serverNow': now.isoformat(), 'targetAt': (existing.target_end_at or target).isoformat(), 'seconds': duration})


@view.route('/pomodoro/complete', methods=['POST'])
@login_required
def complete_pomodoro():
    payload = json.loads(request.data)
    session_id = payload.get('sessionId')
    sess = PomodoroSession.query.get(session_id)
    if not sess or sess.user_id != current_user.id or sess.status != 'running':
        return jsonify({'ok': False}), 403

    now = datetime.now(timezone.utc)
    # Prefer absolute target_end_at if available
    if sess.target_end_at:
        remaining = (sess.target_end_at - now).total_seconds()
        if remaining > 0:
            return jsonify({'ok': False, 'error': 'not_elapsed', 'remaining': int(remaining)}), 400
    else:
        # Fallback to duration based on note
        elapsed = (now - sess.started_at).total_seconds()
        note = Note.query.get(sess.note_id)
        duration = (note.pomodoro_seconds if note and note.pomodoro_seconds else POMODORO_SECONDS)
        if elapsed < duration:
            return jsonify({'ok': False, 'error': 'not_elapsed', 'remaining': int(duration - elapsed)}), 400

    sess.status = 'completed'
    sess.ended_at = now
    note = Note.query.get(sess.note_id)
    if note:
        note.pomodoros = (note.pomodoros or 0) + 1
    db.session.commit()
    return jsonify({'ok': True, 'pomodoros': note.pomodoros if note else None})


@view.route('/pomodoro/cancel', methods=['POST'])
@login_required
def cancel_pomodoro():
    payload = json.loads(request.data)
    session_id = payload.get('sessionId')
    sess = PomodoroSession.query.get(session_id)
    if not sess or sess.user_id != current_user.id or sess.status != 'running':
        return jsonify({'ok': False}), 403
    sess.status = 'canceled'
    sess.ended_at = datetime.now(timezone.utc)
    db.session.commit()
    return jsonify({'ok': True})


@view.route('/pomodoro/pause', methods=['POST'])
@login_required
def pause_pomodoro():
    payload = json.loads(request.data)
    session_id = payload.get('sessionId')
    remaining = payload.get('remainingSeconds')
    sess = PomodoroSession.query.get(session_id)
    if not sess or sess.user_id != current_user.id or sess.status != 'running':
        return jsonify({'ok': False}), 403
    if not isinstance(remaining, int) or remaining < 0:
        return jsonify({'ok': False, 'error': 'invalid_remaining'}), 400
    sess.is_paused = True
    sess.paused_at = datetime.now(timezone.utc)
    sess.remaining_seconds = remaining
    db.session.commit()
    return jsonify({'ok': True})


@view.route('/pomodoro/resume', methods=['POST'])
@login_required
def resume_pomodoro():
    payload = json.loads(request.data)
    session_id = payload.get('sessionId')
    sess = PomodoroSession.query.get(session_id)
    if not sess or sess.user_id != current_user.id or sess.status != 'running':
        return jsonify({'ok': False}), 403
    if not sess.is_paused or not isinstance(sess.remaining_seconds, int) or sess.remaining_seconds <= 0:
        return jsonify({'ok': False, 'error': 'not_paused'}), 400
    now = datetime.now(timezone.utc)
    sess.is_paused = False
    sess.started_at = now
    sess.target_end_at = now + timedelta(seconds=int(sess.remaining_seconds))
    sess.paused_at = None
    db.session.commit()
    return jsonify({'ok': True, 'targetAt': sess.target_end_at.isoformat()})


@view.route('/pomodoro/active', methods=['GET'])
@login_required
def active_pomodoros():
    sessions = PomodoroSession.query.filter_by(user_id=current_user.id, status='running').all()
    resp = []
    now = datetime.now(timezone.utc)

    def _to_utc(dt):
        """Ensure we always work with timezone-aware UTC datetimes.

        Older rows or some backends may return naive datetimes; in that case we
        treat them as UTC so arithmetic with `now` (which is UTC-aware) works.
        """
        if dt is None:
            return None
        if dt.tzinfo is None:
            return dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)

    for s in sessions:
        # Normalize stored datetimes to UTC-aware objects
        started_at = _to_utc(s.started_at)
        target_end_at = _to_utc(s.target_end_at) if s.target_end_at else None

        # Calculate remaining based on target_end_at if present, else estimate from started_at + note default
        if target_end_at:
            target_at = target_end_at
            remaining = max(0, int((target_at - now).total_seconds()))
        else:
            note = Note.query.get(s.note_id)
            duration = note.pomodoro_seconds if note and note.pomodoro_seconds else POMODORO_SECONDS
            base_start = started_at or now
            target_at = base_start + timedelta(seconds=duration)
            remaining = max(0, int((target_at - now).total_seconds()))

        resp.append({
            'sessionId': s.id,
            'noteId': s.note_id,
            'targetAt': target_at.isoformat(),
            'isPaused': bool(s.is_paused),
            'remainingSeconds': int(s.remaining_seconds or remaining),
        })
    return jsonify({'ok': True, 'sessions': resp})
