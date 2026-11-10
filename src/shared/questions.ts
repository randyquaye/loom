import { questionAnswer, type QuestionAnswer, type QuestionRequest } from './events'

export function validateQuestionAnswers(
  request: QuestionRequest,
  input: QuestionAnswer
): QuestionAnswer['answers'] {
  const parsed = questionAnswer.parse(input)
  if (
    parsed.requestId !== request.requestId ||
    Object.keys(parsed.answers).length !== request.questions.length ||
    request.questions.some((question) => !Object.hasOwn(parsed.answers, question.id))
  ) {
    throw new Error('Answers must match the requested questions')
  }
  return parsed.answers
}

export function visibleQuestionAnswers(
  request: QuestionRequest,
  answers: QuestionAnswer['answers']
): QuestionAnswer['answers'] {
  return Object.fromEntries(
    request.questions.map((question) => [
      question.id,
      question.isSecret ? ['[hidden]'] : (answers[question.id] ?? [])
    ])
  )
}

export function questionAnswerText(request: QuestionRequest, answers: QuestionAnswer['answers']): string {
  return request.questions
    .map(
      (question) =>
        `[${question.header}] ${question.question}\nAnswer: ${(answers[question.id] ?? []).join(', ')}`
    )
    .join('\n\n')
}
