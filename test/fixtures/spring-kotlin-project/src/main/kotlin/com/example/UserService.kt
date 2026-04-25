package com.example

import org.springframework.stereotype.Service
import org.springframework.stereotype.Repository
import org.springframework.stereotype.Component

@Service
class UserService(private val userRepository: UserRepository) {
    fun findAll(): List<User> = userRepository.findAll()
    fun findById(id: Long): User = userRepository.findById(id).orElseThrow()
    fun save(user: User): User = userRepository.save(user)
    fun update(id: Long, user: User): User = userRepository.save(user.copy(id = id))
    fun delete(id: Long) = userRepository.deleteById(id)
}

@Repository
class UserRepository {
    fun findAll(): List<User> = emptyList()
    fun findById(id: Long): java.util.Optional<User> = java.util.Optional.empty()
    fun save(user: User): User = user
    fun deleteById(id: Long) {}
}

@Component
class AuditLogger {
    fun log(message: String) {}
}

data class User(val id: Long = 0, val name: String, val email: String)
