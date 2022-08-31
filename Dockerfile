FROM python:3.8
RUN apt-get update \
    && apt-get install -y libsndfile-dev ffmpeg
RUN pip install -q \
    ipywidgets \
    jupyterlab \
    librosa \
    sndfile