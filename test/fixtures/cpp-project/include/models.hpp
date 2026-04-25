#pragma once
#include <string>
#include <vector>
#include <optional>

namespace App {
namespace Models {

/// A two-dimensional point.
struct Point {
    double x;
    double y;
};

/// A three-dimensional vector.
struct Vec3 {
    float x, y, z;

    Vec3 operator+(const Vec3& other) const;
    float dot(const Vec3& other) const;
};

/// User roles in the system.
enum class Role {
    Guest,
    User,
    Admin,
};

/// Application user record.
struct User {
    int         id;
    std::string name;
    std::string email;
    Role        role;
};

/// Pagination parameters.
struct PageParams {
    int page   = 1;
    int limit  = 20;
    int offset() const { return (page - 1) * limit; }
};

/// Template repository for CRUD operations.
template<typename T>
class Repository {
public:
    Repository() = default;

    void add(const T& item);
    void remove(int id);
    std::optional<T> findById(int id) const;
    std::vector<T> findAll() const;

private:
    std::vector<T> _items;
    int            _nextId = 1;
};

}  // namespace Models
}  // namespace App
