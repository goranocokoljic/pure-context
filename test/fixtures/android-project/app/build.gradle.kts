plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.google.dagger.hilt.android")
}

android {
    namespace = "com.example.app"
    compileSdk = 34
}

dependencies {
    implementation(project(":core"))
    implementation("androidx.activity:activity-compose:1.9.0")
    implementation("com.google.dagger:hilt-android:2.51")
}
