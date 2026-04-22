"""Command line entry point."""

import typer

app = typer.Typer(help="Code Review Agent CLI")


@app.command()
def version() -> None:
    """Print the runtime version."""
    from code_review_agent import __version__

    typer.echo(__version__)
