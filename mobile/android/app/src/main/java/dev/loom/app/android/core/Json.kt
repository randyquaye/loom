package dev.loom.app.android.core

import com.squareup.moshi.JsonDataException
import com.squareup.moshi.JsonReader
import com.squareup.moshi.JsonWriter
import okio.Buffer
import java.io.IOException

/**
 * The app's dynamic JSON values over Moshi's streaming tokenizer and writer: this file holds
 * no parsing or escaping of its own, only the mapping to and from plain Kotlin values.
 *
 * Values are Map<String, Any?> (insertion ordered), List<Any?>, String, Long (integer
 * literals only), Double (fraction or exponent present), Boolean and null. Duplicate keys,
 * trailing content and nesting beyond [MAX_DEPTH] are refused. Like JavaScript's
 * JSON.stringify, the writer never escapes '/', which signed canonical payloads depend on.
 */
object Json {
    class JsonException(message: String) : Exception(message)

    const val MAX_DEPTH = 128

    fun parse(text: String): Any? = try {
        val reader = JsonReader.of(Buffer().writeUtf8(text))
        val value = read(reader, 0)
        if (reader.peek() != JsonReader.Token.END_DOCUMENT) throw JsonException("Unexpected trailing content")
        value
    } catch (error: IOException) {
        throw JsonException(error.message ?: "Malformed JSON")
    } catch (error: JsonDataException) {
        throw JsonException(error.message ?: "Malformed JSON")
    }

    private fun read(reader: JsonReader, depth: Int): Any? {
        if (depth > MAX_DEPTH) throw JsonException("Too deeply nested")
        return when (reader.peek()) {
            JsonReader.Token.BEGIN_OBJECT -> {
                val map = LinkedHashMap<String, Any?>()
                reader.beginObject()
                while (reader.hasNext()) {
                    val key = reader.nextName()
                    if (map.containsKey(key)) throw JsonException("Duplicate key")
                    map[key] = read(reader, depth + 1)
                }
                reader.endObject()
                map
            }
            JsonReader.Token.BEGIN_ARRAY -> {
                val list = ArrayList<Any?>()
                reader.beginArray()
                while (reader.hasNext()) list += read(reader, depth + 1)
                reader.endArray()
                list
            }
            JsonReader.Token.STRING -> reader.nextString()
            // The literal as written: only an integer literal that fits is a Long.
            JsonReader.Token.NUMBER -> reader.nextString().let { it.toLongOrNull() ?: it.toDouble() }
            JsonReader.Token.BOOLEAN -> reader.nextBoolean()
            JsonReader.Token.NULL -> reader.nextNull<Any?>()
            else -> throw JsonException("Unexpected token")
        }
    }

    fun encode(value: Any?): String {
        val out = Buffer()
        val writer = JsonWriter.of(out)
        writer.serializeNulls = true
        write(writer, value)
        return out.readUtf8()
    }

    fun quote(value: String): String = encode(value)

    private fun write(writer: JsonWriter, value: Any?) {
        when (value) {
            null -> writer.nullValue()
            is String -> writer.value(value)
            is Boolean -> writer.value(value)
            is Long, is Int, is Short, is Byte -> writer.value((value as Number).toLong())
            is Double -> {
                require(value.isFinite()) { "Non-finite number" }
                // Whole numbers are written as integers, as JavaScript does.
                if (value == Math.rint(value) && kotlin.math.abs(value) < 9.007199254740992E15) {
                    writer.value(value.toLong())
                } else {
                    writer.value(value)
                }
            }
            is Map<*, *> -> {
                writer.beginObject()
                for ((key, item) in value) {
                    writer.name(key as String)
                    write(writer, item)
                }
                writer.endObject()
            }
            is Iterable<*> -> {
                writer.beginArray()
                for (item in value) write(writer, item)
                writer.endArray()
            }
            else -> throw IllegalArgumentException("Unsupported JSON value ${value::class.java.simpleName}")
        }
    }
}

// Narrow typed accessors for parsed JSON objects.
@Suppress("UNCHECKED_CAST")
fun Any?.asObject(): Map<String, Any?>? = this as? Map<String, Any?>
fun Any?.asList(): List<Any?>? = this as? List<Any?>
fun Map<String, Any?>.string(key: String): String? = this[key] as? String
fun Map<String, Any?>.long(key: String): Long? = this[key] as? Long
fun Map<String, Any?>.bool(key: String): Boolean? = this[key] as? Boolean
fun Map<String, Any?>.obj(key: String): Map<String, Any?>? = this[key].asObject()
fun Map<String, Any?>.list(key: String): List<Any?>? = this[key].asList()

/** A JSON number as JavaScript sees it: integer literal or finite fraction. */
fun Map<String, Any?>.number(key: String): Double? = when (val v = this[key]) {
    is Long -> v.toDouble()
    is Double -> if (v.isFinite()) v else null
    else -> null
}
