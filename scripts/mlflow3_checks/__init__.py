"""Checks that run the official MLflow 3 SDK against Mado Model Tracking, one area per module.

scripts/verify_mlflow3.py configures the tracking URI and token, then calls each module's
``verify_*`` function and stores the returned summary.
"""
