plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.example.core"
    compileSdk = 34
}

dependencies {
    implementation("com.google.dagger:hilt-android:2.51")
    implementation("androidx.room:room-runtime:2.6.1")
}
