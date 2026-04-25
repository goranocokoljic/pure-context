package com.example.models

import java.io.Serializable
import com.example.util.DateUtils

/** Represents an application user. */
data class User(
    val id: Long,
    val name: String,
    val email: String,
) : Serializable {

    /** Returns a formatted display name. */
    fun displayName(): String = "$name <$email>"

    fun isValid(): Boolean = email.contains("@")

    private fun internalSecret(): String = "shh"

    companion object {
        /** Creates a guest user. */
        fun guest(): User = User(0L, "Guest", "guest@example.com")

        fun fromMap(map: Map<String, String>): User =
            User(0L, map["name"] ?: "", map["email"] ?: "")
    }
}
