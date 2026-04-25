from flask import Flask, jsonify, request
from flask.views import MethodView
from blueprints.users import users_bp

app = Flask(__name__)
app.register_blueprint(users_bp)


@app.route('/health')
def health():
    """Health check endpoint."""
    return jsonify({'status': 'ok'})


@app.route('/items', methods=['GET', 'POST'])
def items():
    """List or create items."""
    if request.method == 'POST':
        return jsonify({'created': True}), 201
    return jsonify({'items': []})


@app.get('/items/<int:item_id>')
def get_item(item_id):
    return jsonify({'id': item_id})


@app.put('/items/<int:item_id>')
def update_item(item_id):
    return jsonify({'updated': item_id})


@app.delete('/items/<int:item_id>')
def delete_item(item_id):
    return jsonify({'deleted': item_id})


class TokenView(MethodView):
    """Class-based view for token operations."""

    def get(self):
        return jsonify({'token': 'abc'})

    def post(self):
        return jsonify({'token': 'new'})


app.add_url_rule('/token', view_func=TokenView.as_view('token'))


def plain_helper():
    """This is not a route — should not be extracted."""
    pass


if __name__ == '__main__':
    app.run(debug=True)
