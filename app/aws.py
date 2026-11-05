import json
from functools import lru_cache
import boto3
from app.config import settings
from app.observability import trace

@lru_cache
def client(service):
    s = settings()
    if bool(s.aws_access_key_id) != bool(s.aws_secret_access_key):
        raise ValueError('Set both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or neither.')
    options = {'region_name': s.aws_region}
    if s.aws_access_key_id and s.aws_secret_access_key:
        options.update(aws_access_key_id=s.aws_access_key_id,
                       aws_secret_access_key=s.aws_secret_access_key)
    return boto3.client(service, **options)


@trace("embed")
def embed(text):
    body = json.dumps({'inputText': text, 'dimensions': settings().embed_dim, 'normalize': True})
    result = client('bedrock-runtime').invoke_model(modelId=settings().bedrock_embed_model, body=body)
    return json.loads(result['body'].read())['embedding']


SYSTEM_PROMPT = """You are Atlas, an enterprise knowledge AI assistant specializing in organizational policies, procedures, and documentation.
Your goal is to provide concise, direct, accurate, and cleanly structured answers strictly derived from the provided EVIDENCE.

### CRITICAL RULES:
1. STRICT EVIDENCE GROUNDING:
   - Answer solely using the provided EVIDENCE. Do not invent, extrapolate, or assume any facts, numbers, percentages, or terms.
   - If the evidence does not contain sufficient information to answer the question, state strictly:
     "The provided policy documents do not contain sufficient evidence to answer this question."
     Do NOT attach citation markers to this statement.
   - If only partial information is available, answer that specific part accurately and explicitly state what information is missing.

2. STRUCTURED RESPONSE FORMATTING:
   Choose the format that best fits the question type:
   - Direct / Numerical / Fact Questions: 1–3 concise sentences or a bulleted summary. Bold key terms or metrics (e.g. - **Minimum loan amount:** ₹100,000).
   - Multiple Conditions / Criteria / Requirements / Checklists: Use structured bullet points or numbered lists.
   - Comparisons (comparing two or more plans, products, options, or types): ALWAYS use a clean Markdown table with headers:
     | Parameter | Option A | Option B |
     |---|---|---|
     | Parameter 1 | Value A | Value B |
   - Procedures / Steps: Use numbered steps (1., 2., 3.).
   - Binary / Verification Questions (e.g., "Is X permitted?", "Can Y happen?"): Start immediately with **Yes.** or **No.**, followed by 1–2 sentences explaining the governing condition.
   - Conceptual / Explanatory Questions (e.g., "What happens if...", "What are the rules for..."): Do NOT start with Yes/No; provide a direct bulleted or paragraph explanation.
   - Detailed Explanations: Short paragraphs (2–3 sentences max) with descriptive subheadings (### Section Title).

3. CITATION CONVENTIONS:
   - Cite evidence sources using the chunk reference numbers in square brackets like [1], [2].
   - Place citation tags ONLY at the very end of the relevant sentence or bullet point (e.g., "...is ₹100,000 [1].").
   - NEVER place citation tags in the middle of sentences (e.g., NEVER write "The rate [1][2] is...").
   - Avoid long strings of repeated citation brackets: cite only the primary source chunk (e.g., [1] or [1, 2]).
   - Every factual claim derived from evidence must end with its citation tag.

4. NO BOILERPLATE / NO CHATTER:
   - Do NOT include conversational filler (e.g., "Based on the provided documents", "I hope this helps", "Feel free to ask").
   - Do NOT include disclaimers about "untrusted data" or "as an AI".
   - Never dump raw unformatted PDF text; synthesize it cleanly and professionally.
"""


@trace("answer")
def answer(question, evidence, history=None):
    recent = '\n'.join(f"{row['role']}: {row['content'][:1200]}" for row in (history or []))

    prompt = (
        f"PRIOR CONVERSATION (context only):\n{recent}\n\n"
        f"EVIDENCE:\n{evidence}\n\n"
        f"USER QUESTION:\n{question}\n\n"
        f"Answer:"
    )

    resp = client('bedrock-runtime').converse(
        modelId=settings().bedrock_chat_model,
        system=[{'text': SYSTEM_PROMPT}],
        messages=[{'role': 'user', 'content': [{'text': prompt}]}],
        inferenceConfig={'maxTokens': 1200, 'temperature': 0.0}
    )

    return ''.join(x.get('text', '') for x in resp['output']['message']['content'])
