package dev.loom.app.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.material3.TextButton
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import dev.loom.app.android.runner.QuestionAnswers
import dev.loom.app.android.runner.QuestionForm
import dev.loom.app.android.runner.QuestionSpec
import dev.loom.app.android.runner.QuestionStatus
import dev.loom.app.android.runner.TranscriptItem

/**
 * Secret answers live only in this card. Ordinary answers belong to the conversation,
 * so scrolling a lazy list cannot erase them. Neither uses persisted saved-state storage.
 */
@Composable
fun QuestionCard(
    item: TranscriptItem.Question,
    canAnswer: Boolean,
    viewOnly: Boolean,
    busy: Boolean,
    submitted: Boolean,
    draft: Map<String, QuestionForm>,
    onDraftChange: (Map<String, QuestionForm>) -> Unit,
    onSubmit: (Map<String, QuestionForm>) -> Boolean,
) {
    val request = item.request
    val secrets = remember(request.requestId) { mutableStateMapOf<String, QuestionForm>() }
    DisposableEffect(request.requestId) { onDispose { secrets.clear() } }
    val forms = draft + secrets
    val open = item.status == QuestionStatus.Open && !submitted
    var expanded by remember(request.requestId) { mutableStateOf(false) }
    val needsExpansion = request.questions.size > 1 || request.questions.any { it.isSecret || it.options.size > 4 }

    Surface(
        color = MaterialTheme.colorScheme.surfaceContainer,
        shape = MaterialTheme.shapes.medium,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(
                if (request.approval) "Approval requested" else "The agent has a question",
                style = MaterialTheme.typography.titleSmall,
                modifier = Modifier.semantics { heading() },
            )
            if (!open) {
                Text(
                    when {
                        submitted && item.status == QuestionStatus.Open -> "Answer sent. Waiting for the agent."
                        item.status == QuestionStatus.Answered -> "Answered."
                        item.status == QuestionStatus.Resolved -> "Resolved."
                        else -> "Closed: the turn ended before an answer."
                    },
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                for (question in request.questions) {
                    val answer = item.visibleAnswers[question.id] ?: continue
                    Text("${question.header.ifBlank { question.question }}: ${answer.joinToString(", ")}", style = MaterialTheme.typography.bodySmall)
                }
                return@Column
            }
            if (needsExpansion && !expanded) {
                request.questions.firstOrNull()?.let { Text(it.question, style = MaterialTheme.typography.bodyLarge) }
                TextButton(onClick = { expanded = true }) { Text(if (request.approval) "Review approval" else "Answer questions") }
                if (viewOnly) Text("View only. Someone with control access can answer.", style = MaterialTheme.typography.bodySmall)
                return@Column
            }
            for (question in request.questions) {
                QuestionFields(question, forms[question.id] ?: QuestionForm(), enabled = canAnswer && !busy) {
                    if (question.isSecret) secrets[question.id] = it
                    else onDraftChange(draft + (question.id to it))
                }
            }
            when {
                viewOnly -> Text("View only. You can't answer in this shared workspace.", style = MaterialTheme.typography.bodySmall)
                else -> {
                    val ready = QuestionAnswers.build(request, forms) != null
                    Button(
                        onClick = { if (onSubmit(forms)) secrets.clear() },
                        enabled = canAnswer && ready && !busy,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(
                            when {
                                busy -> "Sending…"
                                request.approval -> "Submit approval"
                                else -> "Submit answer"
                            }
                        )
                    }
                }
            }
            if (needsExpansion && expanded) TextButton(onClick = { expanded = false; secrets.clear() }) { Text("Hide questions") }
        }
    }
}

@Composable
private fun QuestionFields(question: QuestionSpec, form: QuestionForm, enabled: Boolean, update: (QuestionForm) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (question.header.isNotBlank()) Text(question.header, style = MaterialTheme.typography.labelLarge)
        Text(question.question, style = MaterialTheme.typography.bodyMedium)
        if (question.options.isNotEmpty()) {
            val choices = question.options.map { it.label to it.description } +
                if (question.isOther) listOf(QuestionForm.OTHER to "") else emptyList()
            Column(if (question.multiSelect) Modifier else Modifier.selectableGroup()) {
                for ((value, description) in choices) {
                    val label = if (value == QuestionForm.OTHER) "Other" else value
                    val checked = value in form.selected
                    val choose = {
                        val next = if (question.multiSelect) {
                            if (checked) form.selected - value else form.selected + value
                        } else {
                            listOf(value)
                        }
                        update(form.copy(selected = next))
                    }
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(min = 48.dp)
                            .then(
                                if (question.multiSelect) {
                                    Modifier.toggleable(checked, enabled = enabled, role = Role.Checkbox) { choose() }
                                } else {
                                    Modifier.selectable(checked, enabled = enabled, role = Role.RadioButton) { choose() }
                                }
                            ),
                    ) {
                        if (question.multiSelect) Checkbox(checked = checked, onCheckedChange = null, enabled = enabled)
                        else RadioButton(selected = checked, onClick = null, enabled = enabled)
                        Column(Modifier.padding(start = 12.dp)) {
                            Text(label, style = MaterialTheme.typography.bodyLarge)
                            if (description.isNotBlank()) {
                                Text(description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }
                }
            }
        }
        if (question.options.isEmpty() || QuestionForm.OTHER in form.selected) {
            OutlinedTextField(
                value = form.text,
                onValueChange = { update(form.copy(text = it.take(20_000))) },
                label = { Text(if (question.isSecret) "Secret answer" else "Answer") },
                enabled = enabled,
                singleLine = question.isSecret,
                visualTransformation = if (question.isSecret) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
                keyboardOptions = if (question.isSecret) {
                    KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false)
                } else {
                    KeyboardOptions.Default
                },
                modifier = Modifier.fillMaxWidth(),
            )
            if (question.isSecret) Text("Hidden in question history", style = MaterialTheme.typography.bodySmall)
        }
    }
}
