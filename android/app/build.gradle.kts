// The Android station for Serene Pager. Its screen is the Windows app's own ../../ui folder, packed in as-is, so the
// two can't drift: a change to ui/ ships to both. Release signing reads android/keystore.properties (not in git).
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val keys = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "dental.serene.pager"
    compileSdk = 35
    defaultConfig {
        applicationId = "dental.serene.pager"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
    }
    signingConfigs {
        if (keys.getProperty("storeFile") != null) create("release") {
            storeFile = file(keys.getProperty("storeFile"))
            storePassword = keys.getProperty("storePassword")
            keyAlias = keys.getProperty("keyAlias")
            keyPassword = keys.getProperty("keyPassword")
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release")
        }
    }
    sourceSets["main"].assets.srcDirs("src/main/assets", "../../ui")
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.webkit:webkit:1.12.1")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
