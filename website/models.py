from . import db
from flask_login import UserMixin
from sqlalchemy.sql import func


class Note(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    data = db.Column(db.String(10000))
    date = db.Column(db.DateTime(timezone=True), default=func.now())  # created_at equivalent
    status = db.Column(db.String(20), default='planned')  # planned | in_progress | completed | canceled
    pomodoros = db.Column(db.Integer, default=0)
    pomodoro_seconds = db.Column(db.Integer, default=25 * 60)  # per-task pomodoro duration
    finish_by = db.Column(db.DateTime(timezone=True))  # optional absolute finish datetime for long sessions
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'))


class PomodoroSession(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    note_id = db.Column(db.Integer, db.ForeignKey('note.id'), nullable=False)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    started_at = db.Column(db.DateTime(timezone=True), server_default=func.now(), nullable=False)
    ended_at = db.Column(db.DateTime(timezone=True))
    status = db.Column(db.String(20), default='running')  # running | completed | canceled
    # Persistence fields
    target_end_at = db.Column(db.DateTime(timezone=True))  # absolute time the session should end
    is_paused = db.Column(db.Boolean, default=False)
    remaining_seconds = db.Column(db.Integer)  # remaining seconds when paused
    paused_at = db.Column(db.DateTime(timezone=True))


class User(db.Model, UserMixin):
    id = db.Column(db.Integer, primary_key=True)
    email = db.Column(db.String(150), unique=True)
    password = db.Column(db.String(150))
    first_name = db.Column(db.String(150))
    notes = db.relationship('Note')
