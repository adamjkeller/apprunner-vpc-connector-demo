FROM public.ecr.aws/docker/library/alpine:3.15.0

ENV TARGET=0.0.0.0
ENV PORT=8080

COPY requirements.txt /

RUN apk add --no-cache curl netcat-openbsd python3 py3-pip python3-dev libpq-dev gcc postgresql &&\
  pip install -r /requirements.txt

COPY main.py /

CMD [ "/main.py" ]