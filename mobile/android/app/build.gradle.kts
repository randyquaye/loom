import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "dev.loom.app.android"
    compileSdk = 37
    buildToolsVersion = "36.0.0"

    defaultConfig {
        // Must stay exact: the runner allowlists dev.loom.app.android:/oauth/callback.
        applicationId = "dev.loom.app.android"
        minSdk = 29
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        resources.excludes += setOf("/META-INF/{AL2.0,LGPL2.1}", "META-INF/versions/9/OSGI-INF/MANIFEST.MF")
    }

    lint {
        abortOnError = true
        checkReleaseBuilds = true
    }

    testOptions {
        unitTests.all {
            // Shared, synthetic cross-platform trust fixture (no private key material).
            it.systemProperty(
                "loom.trustFixture",
                rootProject.file("../contracts/trust-fixture.json").absolutePath
            )
        }
    }
}

kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2026.09.00")
    implementation(composeBom)
    implementation("androidx.activity:activity-compose:1.9.3")
    // Auth Tab: the sign-in redirect returns as an activity result, never as an intent.
    implementation("androidx.browser:browser:1.9.0")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-core")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
    implementation("com.squareup.okhttp3:okhttp:5.5.1")
    implementation("com.mikepenz:multiplatform-markdown-renderer-m3:0.43.0")
    // Streaming JSON tokenizer and writer only (no reflection or code generation).
    implementation("com.squareup.moshi:moshi:1.15.2")
    // Ed25519 verification on API 29-32, where the platform provider has no Ed25519.
    implementation("com.google.crypto.tink:tink-android:1.24.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.11.0")

    // On-device only: the real Android Keystore behind KeystoreCipher.
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
}
