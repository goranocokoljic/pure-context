/// A plain Dart data class — NOT a widget.
class User {
  final String id;
  final String name;
  final String email;

  const User({required this.id, required this.name, required this.email});

  User.fromJson(Map<String, dynamic> json)
      : id = json['id'] as String,
        name = json['name'] as String,
        email = json['email'] as String;

  @override
  String toString() => 'User($name)';
}

enum UserRole { admin, user, guest }
