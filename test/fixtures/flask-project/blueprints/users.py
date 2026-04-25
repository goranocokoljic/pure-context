from flask import Blueprint, jsonify, request

users_bp = Blueprint('users', __name__, url_prefix='/users')


@users_bp.route('/')
def list_users():
    """List all users."""
    return jsonify({'users': []})


@users_bp.route('/<int:user_id>')
def get_user(user_id):
    """Get a single user."""
    return jsonify({'id': user_id})


@users_bp.post('/')
def create_user():
    """Create a new user."""
    return jsonify({'created': True}), 201


@users_bp.put('/<int:user_id>')
def update_user(user_id):
    return jsonify({'updated': user_id})


@users_bp.delete('/<int:user_id>')
def delete_user(user_id):
    return jsonify({'deleted': user_id})
