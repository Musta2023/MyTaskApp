# create_tables.py
from main import app
from website import db

with app.app_context():
    # This will create all tables based on your models
    db.create_all()
    print("Database tables created successfully!")
