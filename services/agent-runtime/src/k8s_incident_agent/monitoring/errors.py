class AlertAuthenticationError(RuntimeError):
    pass


class AlertPayloadTooLargeError(RuntimeError):
    pass


class AlertPayloadInvalidError(RuntimeError):
    pass


class AlertPayloadTruncatedError(RuntimeError):
    pass


class AlertTargetInvalidError(RuntimeError):
    pass
