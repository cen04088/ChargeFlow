from django.conf import settings

def analytics_keys(request):
    return {
        'GA_MEASUREMENT_ID': settings.GA_MEASUREMENT_ID,
        'AMPLITUDE_API_KEY': settings.AMPLITUDE_API_KEY,
    }