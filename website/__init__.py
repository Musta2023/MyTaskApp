import os
from flask import Flask
from flask_sqlalchemy import SQLAlchemy
from flask_login import LoginManager
from dotenv import load_dotenv

db = SQLAlchemy()


def create_app():
    load_dotenv()
    
    # Conditionally set instance_path.
    # On Vercel (Linux), use the writable /tmp directory.
    # On local Windows, let Flask create a default 'instance' folder in the project root.
    if os.name == 'nt':
        app = Flask(__name__, instance_relative_config=True)
        # Ensure the local instance folder exists
        try:
            os.makedirs(app.instance_path)
        except OSError:
            pass
    else:
        app = Flask(__name__, instance_path='/tmp/instance')

    app.config['SECRET_KEY'] = 'MUSTAPHA@1234' # This should also be an environment variable

    # Get the database URL from environment variables
    db_url = os.environ.get('POSTGRES_URL')

    if db_url:
        # Vercel's POSTGRES_URL starts with 'postgres://', but SQLAlchemy needs 'postgresql://'
        app.config['SQLALCHEMY_DATABASE_URI'] = db_url.replace("postgres://", "postgresql://", 1)
    else:
        # Fallback to a local SQLite database if the env var is not set (for local development)
        db_path = os.path.join(os.path.dirname(__file__), '..', 'instance', 'database.db')
        app.config['SQLALCHEMY_DATABASE_URI'] = f'sqlite:///{db_path}'
        # Ensure the instance directory exists for local development
        os.makedirs(os.path.dirname(db_path), exist_ok=True)

    db.init_app(app)

    from .view import view
    from .auth import auth

    app.register_blueprint(view, url_prefix='/')
    app.register_blueprint(auth, url_prefix='/')

    from .models import User, Note

    login_manager = LoginManager()
    login_manager.login_view = 'auth.login'
    login_manager.init_app(app)

    @login_manager.user_loader
    def load_user(id):
        return User.query.get(int(id))

    return app


def create_database(app):
    """Creates the local SQLite database."""
    with app.app_context():
        db.create_all()
        print('Created local SQLite database!')