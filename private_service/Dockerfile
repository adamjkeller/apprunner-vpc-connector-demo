FROM public.ecr.aws/docker/library/alpine:3.15.0

COPY requirements.txt /

RUN apk add --no-cache curl python3 py3-pip &&\
  pip install -r /requirements.txt

COPY main.py /

CMD [ "/main.py" ]