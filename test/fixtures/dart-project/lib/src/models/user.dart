/// Represents an application user.
class User {
  final String name;
  final String email;
  final int age;

  const User({required this.name, required this.email, required this.age});

  /// Creates a User from a JSON map.
  User.fromJson(Map<String, dynamic> json)
      : name = json['name'] as String,
        email = json['email'] as String,
        age = json['age'] as int;

  factory User.empty() => const User(name: '', email: '', age: 0);

  /// Returns a copy of this User with updated fields.
  User copyWith({String? name, String? email, int? age}) {
    return User(
      name: name ?? this.name,
      email: email ?? this.email,
      age: age ?? this.age,
    );
  }

  bool get isAdult => age >= 18;

  bool operator ==(Object other) =>
      other is User && other.email == email;

  @override
  int get hashCode => email.hashCode;

  @override
  String toString() => 'User($name, $email)';

  // Private method — should not be extracted
  bool _validate() => name.isNotEmpty && email.contains('@');
}

enum UserRole { admin, moderator, user, guest }
