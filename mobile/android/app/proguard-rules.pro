# Tink references optional annotation and HTTP-client classes that are not shipped or used.
-dontwarn com.google.errorprone.annotations.**
-dontwarn javax.annotation.**
-dontwarn com.google.api.client.**
-dontwarn org.joda.time.**
# No reflection-based serialization is used; nothing else needs keeping.
