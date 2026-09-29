# Generative AI in University Teaching: A Practical Guide

Written for the AutoGenBook benchmark. Original text, released under the
repository's Apache 2.0 licence.

## 1. What generative AI is

Artificial intelligence is a broad field that studies how machines can perform
tasks usually associated with human intelligence, such as recognising
patterns, planning, or understanding language. Traditional AI systems are
mostly discriminative: they classify or predict, for example deciding whether
an e-mail is spam or estimating tomorrow's electricity demand. Generative AI
is the branch that produces new content. A generative model can write a
paragraph, draft program code, compose an image or summarise a long report in
response to an instruction written in plain language.

The instruction a user gives to a generative model is called a prompt. The
quality of the output depends strongly on the prompt, on the model, and on the
information the model has access to at the moment of generation. Generative
tools do not look answers up in a database of verified facts; they produce the
continuation that is statistically most plausible given their training.

## 2. How large language models work

Large language models (LLMs) are neural networks trained on very large
collections of text. Their core task is simple to state: given a sequence of
text, predict the next piece of text. Repeating this prediction step many
times produces whole sentences and documents.

### 2.1 Tokens

Models do not read characters or whole words. Text is first split into tokens,
which are frequent fragments of words. A short common word is usually a single
token, while a rare or long word is split into several tokens. As a rule of
thumb, one token corresponds to roughly three quarters of an English word, and
languages with rich inflection such as Czech need more tokens for the same
content. Token counts matter in practice because providers price usage per
token and because every model has a maximum context length measured in
tokens.

### 2.2 Embeddings

Each token is mapped to a vector of numbers called an embedding. Embeddings
place words with related meanings close to each other in a high-dimensional
space, so that the model can generalise from one expression to a similar one.
The same idea is used in search: documents and questions are converted into
embeddings, and the documents whose vectors are closest to the question are
retrieved. This technique is the basis of retrieval-augmented generation,
where a model answers using passages retrieved from a trusted collection of
documents instead of relying only on what it memorised during training.

### 2.3 Training data

A model learns its statistical patterns from its training data, typically web
pages, books, source code and other public text, followed by a phase of
instruction tuning in which people rate or write example answers. The
training data determine what the model knows, which languages it handles
well, and which biases it reproduces. Because training stops at a fixed
moment, every model has a knowledge cut-off date after which it knows nothing
unless the information is supplied in the prompt.

## 3. Common tools

Several general-purpose assistants are widely available to teachers. Chat
assistants such as ChatGPT, Claude, Gemini and Microsoft Copilot all accept
free-form instructions and can process uploaded documents. They differ in the
length of documents they accept, in their integration with office software,
and in their data-protection terms. Institutional or enterprise licences
usually guarantee that conversations are not used to train future models,
which is an important condition for working with any material related to
students.

Before recommending a tool to students, a teacher should check three things:
whether the university provides a licensed version, what happens to the data
entered into it, and whether the tool is accessible to all students regardless
of their budget.

## 4. Limitations every teacher should know

### 4.1 Hallucinations

A hallucination is a fluent, confident statement that is false. Models may
invent references to articles that do not exist, attribute quotations to the
wrong person or produce plausible but incorrect numbers. Hallucinations are a
consequence of how the models work, not a rare malfunction, so every factual
claim produced by a model has to be verified against a reliable source before
it is used in teaching material.

### 4.2 Bias

Models reproduce patterns present in their training data, including
stereotypes about gender, nationality or profession. Bias can appear subtly,
for example in the default names chosen for characters in an exercise or in
which perspectives are presented as neutral. Teachers can counter this by
asking for several alternatives and by reviewing generated examples with the
same care as any other material.

### 4.3 Knowledge cut-off and missing context

A model knows nothing about events after its knowledge cut-off and nothing
about local rules, such as the study regulations of a particular faculty,
unless these are provided in the prompt. Asking a model about the current
exam schedule of a course will produce an invented answer.

### 4.4 What models cannot do

Models do not have intentions, values or responsibility. They cannot take
ethical decisions on behalf of a teacher, they do not know the students, and
they cannot judge whether an assignment fits the learning outcomes of a
course. These judgements remain the responsibility of the teacher.

## 5. Prompt engineering for teachers

Prompt engineering is the practice of writing instructions that reliably
produce useful output. A good prompt states the role the model should take,
the task, the context, the audience, the desired format and the length.

### 5.1 The structure of an effective prompt

An effective prompt usually contains five elements: context that explains the
situation, a clear task, constraints on length and format, one or more
examples of the expected result, and a description of the audience. Omitting
the audience is the most common mistake, because the same topic must be
explained very differently to first-year students and to doctoral candidates.

### 5.2 Zero-shot, few-shot and chain-of-thought prompting

In zero-shot prompting the model receives only the instruction. In few-shot
prompting the instruction is followed by a small number of worked examples,
which is particularly effective for tasks with a fixed format such as writing
multiple-choice questions in the style of an existing test. Chain-of-thought
prompting asks the model to reason step by step before giving the final
answer, which improves results on multi-step problems in mathematics or
engineering.

### 5.3 Role prompting

Role prompting assigns the model a persona, for example an experienced
reviewer of engineering theses or a patient tutor for first-year physics. A
role helps the model choose an appropriate vocabulary and level of detail,
but it does not give the model any expertise it did not already have.

## 6. Using AI to prepare teaching

### 6.1 Course materials

Teachers report the largest time savings when they use generative tools for
first drafts: lecture outlines, lists of discussion questions, worked
examples and summaries of long readings. The draft is then edited by the
teacher, who adds course-specific context and checks every fact.

### 6.2 Quizzes and question banks

A model can generate a bank of questions at different difficulty levels from
a lecture transcript or a chapter of a textbook. It is good practice to ask
for the correct answer, an explanation, and the typical misconception behind
each wrong option, and to discard questions that test trivia instead of
understanding.

### 6.3 Rubrics

Generative tools are useful for drafting assessment rubrics: the teacher
lists the learning outcomes and the model proposes criteria and descriptions
of performance levels. The teacher must adjust the rubric to the actual
assignment and calibrate it on a few real student submissions.

## 7. Supporting students

### 7.1 Feedback

Models can give students immediate formative feedback on drafts, for example
comments on the structure of an essay or on the readability of program code.
Such feedback complements but does not replace feedback from the teacher,
and students should be told clearly which parts of the feedback process are
automated.

### 7.2 Tutoring and accessibility

Used as a tutor, a model can explain a concept in several ways, generate
practice problems and adapt the pace to the student. Generative tools can
also improve accessibility, for example by producing plain-language summaries
or transcripts, which helps students with learning difficulties and students
studying in a second language.

### 7.3 Developing AI literacy

Students need AI literacy: the ability to use generative tools effectively,
to recognise their limitations, and to decide when their use is appropriate.
Teachers can build this literacy by demonstrating a hallucination in class,
by asking students to verify generated claims, and by discussing openly when
the use of AI would undermine the purpose of an assignment.
