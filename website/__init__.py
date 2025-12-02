from flask import Flask
from flask_sqlalchemy import SQLAlchemy
from os import path
from flask_login import LoginManager
from dotenv import load_dotenv

db = SQLAlchemy()
DB_NAME = "database.db"


def create_app():
    load_dotenv()
    app = Flask(__name__)
    app.config['SECRET_KEY'] = 'MUSTAPHA@1234'
    app.config['SQLALCHEMY_DATABASE_URI'] = f'sqlite:///{DB_NAME}'
    db.init_app(app)

    from .view import view
    from .auth import auth

    app.register_blueprint(view, url_prefix='/')
    app.register_blueprint(auth, url_prefix='/')

    from .models import User, Note
    
    with app.app_context():
        db.create_all()
        # Simple migration: add columns if they don't exist (SQLite-safe)
        try:
            from sqlalchemy import text
            with db.engine.connect() as conn:
                # Note table migrations
                cols = [row[1] for row in conn.execute(text("PRAGMA table_info('note')"))]
                if 'status' not in cols:
                    conn.execute(text("ALTER TABLE note ADD COLUMN status VARCHAR(20) DEFAULT 'planned'"))
                if 'pomodoros' not in cols:
                    conn.execute(text("ALTER TABLE note ADD COLUMN pomodoros INTEGER DEFAULT 0"))
                if 'pomodoro_seconds' not in cols:
                    conn.execute(text("ALTER TABLE note ADD COLUMN pomodoro_seconds INTEGER DEFAULT 1500"))
                if 'finish_by' not in cols:
                    conn.execute(text("ALTER TABLE note ADD COLUMN finish_by DATETIME"))
                
                # PomodoroSession table migrations
                sess_cols = [row[1] for row in conn.execute(text("PRAGMA table_info('pomodoro_session')"))]
                if 'target_end_at' not in sess_cols:
                    conn.execute(text("ALTER TABLE pomodoro_session ADD COLUMN target_end_at DATETIME"))
                if 'is_paused' not in sess_cols:
                    conn.execute(text("ALTER TABLE pomodoro_session ADD COLUMN is_paused BOOLEAN DEFAULT 0"))
                if 'remaining_seconds' not in sess_cols:
                    conn.execute(text("ALTER TABLE pomodoro_session ADD COLUMN remaining_seconds INTEGER"))
                if 'paused_at' not in sess_cols:
                    conn.execute(text("ALTER TABLE pomodoro_session ADD COLUMN paused_at DATETIME"))
        except Exception:
            # Ignore migration errors in case of non-SQLite or already migrated
            pass

    login_manager = LoginManager()
    login_manager.login_view = 'auth.login'
    login_manager.init_app(app)

    @login_manager.user_loader
    def load_user(id):
        return User.query.get(int(id))

    return app


def create_database(app):
    if not path.exists('website/' + DB_NAME):
        db.create_all(app=app)
        print('Created Database!')
