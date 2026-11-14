"""Keep reconstructed async prompts consistent with accepted desktop conversation input."""
import json


def _question_key(value):
    if not isinstance(value, str):
        return None
    try:
        key = json.loads(value)
    except (ValueError, TypeError):
        return None
    if (not isinstance(key, list) or len(key) != 3 or key[0] != 'request_user_input_async'
            or not isinstance(key[1], str) or type(key[2]) is not int or key[2] < 0):
        return None
    return tuple(key)


def _inputs(model, turn):
    # A hydrated turn can expose its initiating user input through params rather than an item.
    content = (turn.get('params') or {}).get('input', [])
    if content:
        yield model.text_content(content)
    for item in model.items_array(turn.get('items')):
        if item.get('type') == 'userMessage' or (
                item.get('type') == 'steeringUserMessage' and item.get('status') == 'accepted'):
            yield model.text_content(item.get('content', item.get('input', [])))


def pending_async_requests(state, model):
    turns = model.ordered_turns(state)
    answered = set()
    for turn in turns:
        for text in _inputs(model, turn):
            answered.update(key for reply in model.question_replies(text)
                            if (key := _question_key(reply.get('questionItemId'))) is not None)
    pending = []
    for turn in turns:
        # New ordinary user input supersedes older prompts. Structured answers only
        # resolve their exact question IDs, preserving other simultaneous cards.
        content = (turn.get('params') or {}).get('input', [])
        if content:
            pending = _after_input(pending, model.text_content(content), model)
        for item in model.items_array(turn.get('items')):
            kind = item.get('type')
            if kind == 'userMessage' or (kind == 'steeringUserMessage' and item.get('status') == 'accepted'):
                pending = _after_input(pending, model.text_content(item.get('content', item.get('input', []))), model)
            if kind == 'agentMessage' and item.get('questions') and turn.get('status') in ('inProgress', 'completed'):
                request = _request(turn, item, answered)
                if request:
                    pending.append(request)
    return pending


def _after_input(pending, text, model):
    return pending if not text.strip() or model.question_replies(text) else []


def _request(turn, item, answered):
    questions = []
    for index, question in enumerate(item['questions']):
        key = ('request_user_input_async', item['id'], index)
        if key not in answered:
            questions.append({'id': json.dumps(key, ensure_ascii=False, separators=(',', ':')),
                              'question': question['title'],
                              'options': [{'label': option} for option in (question.get('options') or [])]})
    if not questions:
        return None
    return {'id': 'async:' + str(turn.get('turnId')) + ':' + item['id'],
            'method': 'bridge/requestUserInputAsync', 'supported': True,
            'params': {'questions': questions}}


def install():
    from bridge.features.sessions import model
    from bridge.app import service
    if getattr(model.async_requests, '_remoteai_native_questions', False):
        return

    def async_requests(state):
        return pending_async_requests(state, model)

    async_requests._remoteai_native_questions = True
    model.async_requests = async_requests
    # respond() imported this symbol directly and must validate the same live set.
    service.async_requests = async_requests
